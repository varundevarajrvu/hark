import { publish } from '../core/bus.ts';
import { messages, newId, recordUsage, threads } from '../core/db.ts';
import { AgentBusyError } from '../core/runtime.ts';
import type { AgentRuntime, HandoffRuntime } from '../core/runtime.ts';
import type { ChatMessage, Id, MessagePart, ToolStatus } from '../../shared/types.ts';
import { LlmCredentialsError, describeLlmError, echoContent, isAbortError } from './llm.ts';
import type { LlmBlock, LlmClient, LlmMessage } from './llm.ts';
import { defaultLlm } from './mock.ts';
import { SYSTEM_PROMPT, buildContextBlock } from './prompt.ts';
import { ORCHESTRATOR_TOOLS, isHandoffTool, runTool, toolLabel } from './tools.ts';
import type { ToolContext } from './tools.ts';

export type { LlmClient, LlmRequest, LlmResponse, LlmBlock, LlmMessage, LlmTool } from './llm.ts';
export { textBlock, toolUseBlock } from './llm.ts';
export { createOfflineClient } from './mock.ts';

/** Model calls allowed in one turn before the agent is made to stop. */
const MAX_MODEL_CALLS = 30;

type RunStatus = 'ok' | 'error' | 'cancelled';
type ToolPart = Extract<MessagePart, { type: 'tool' }>;
type TextPart = Extract<MessagePart, { type: 'text' }>;
type ToolUse = Extract<LlmBlock, { type: 'tool_use' }>;
type ToolResult = { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

interface Run {
  runId: Id;
  userId: Id;
  threadId: Id;
  assistantId: Id;
  unattended: boolean;
  abort: AbortController;
}

export function createAgentRuntime(deps: { handoff: HandoffRuntime; llm?: LlmClient }): AgentRuntime {
  const llm = deps.llm ?? defaultLlm();
  const runs = new Map<Id, Run>(); // by thread: one run per thread

  function startTurn(opts: Parameters<AgentRuntime['startTurn']>[0]): ReturnType<AgentRuntime['startTurn']> {
    const { userId, threadId, text } = opts;
    if (runs.has(threadId)) throw new AgentBusyError();
    if (!threads.get(userId, threadId)) throw new Error('Thread not found.');

    // Volatile state rides in the user turn, so the system prompt stays byte-stable and history append-only.
    const context = buildContextBlock({ userId, threadId, unattended: opts.unattended });
    const userMessageId = messages.append({
      userId, threadId, role: 'user', source: opts.source,
      parts: [{ type: 'text', id: newId('prt'), text }],
      api: { role: 'user', content: [{ type: 'text', text: context.text }, { type: 'text', text }] },
    });
    context.commit();
    publish(userId, { type: 'message.created', threadId, message: messages.get(userId, userMessageId)! });

    // The one visible assistant message of this turn. Its id is stable; only its parts change.
    const assistantId = messages.append({ userId, threadId, role: 'assistant', api: null, parts: [] });
    const run: Run = { runId: newId('run'), userId, threadId, assistantId, unattended: opts.unattended === true, abort: new AbortController() };
    runs.set(threadId, run);
    publish(userId, { type: 'run.started', threadId, runId: run.runId, messageId: assistantId });

    const done = execute(run)
      .catch((err): RunStatus => {
        console.error('[agent] run failed outside the turn loop', err);
        return 'error';
      })
      .finally(() => {
        if (runs.get(threadId) === run) runs.delete(threadId);
      });
    return { runId: run.runId, done };
  }

  async function execute(run: Run): Promise<RunStatus> {
    const { userId, threadId, assistantId } = run;
    const signal = run.abort.signal;
    const parts: MessagePart[] = [];
    let closed = false;
    let status: RunStatus = 'ok';
    let error: string | undefined;
    /** tool_use ids already written to the API history that still lack a tool_result. */
    let unanswered: string[] = [];

    const save = () => messages.setParts(assistantId, parts);
    const putPart = (part: Exclude<MessagePart, { type: 'text' }>) => {
      if (closed) return; // a tool that finished after the turn ended must not touch the stored message
      const at = parts.findIndex((p) => p.id === part.id);
      if (at >= 0) parts[at] = part;
      else parts.push(part);
      save();
      publish(userId, { type: 'message.part', threadId, messageId: assistantId, part });
    };
    const notice = (tone: 'info' | 'error', text: string) => putPart({ type: 'notice', id: newId('prt'), tone, text });
    const toolPart = (id: string): ToolPart | undefined => parts.find((p): p is ToolPart => p.type === 'tool' && p.id === id);
    const setTool = (id: string, name: string, patch: Partial<ToolPart>) => {
      const cur = toolPart(id) ?? { type: 'tool' as const, id, name, label: toolLabel(name, {}), status: 'running' as ToolStatus };
      putPart({ ...cur, ...patch });
    };
    const appendApi = (role: 'user' | 'assistant', content: unknown) => messages.append({ userId, threadId, role, api: { role, content }, parts: null });
    const answer = (results: ToolResult[]) => {
      appendApi('user', results);
      unanswered = [];
    };

    try {
      for (let call = 0; ; call++) {
        if (signal.aborted) break;
        if (call >= MAX_MODEL_CALLS) {
          notice('info', `Stopped after ${MAX_MODEL_CALLS} steps. Ask me to continue if there is more to do.`);
          break;
        }

        const mark = parts.length;
        let streamed = false;
        let openText: TextPart | null = null;
        const addText = (text: string) => {
          if (!text) return;
          if (!openText) parts.push((openText = { type: 'text', id: newId('prt'), text: '' }));
          openText.text += text;
          publish(userId, { type: 'message.delta', threadId, messageId: assistantId, partId: openText.id, text });
        };

        const res = await llm.runTurn({
          system: SYSTEM_PROMPT,
          messages: messages.apiHistory(userId, threadId) as LlmMessage[],
          tools: ORCHESTRATOR_TOOLS,
          signal,
          onTextDelta: (text) => {
            streamed = true;
            addText(text);
          },
          onToolStart: (t) => {
            streamed = true;
            openText = null;
            setTool(t.id, t.name, {});
          },
        });
        recordUsage(userId, threadId, res.model, res.usage.input_tokens, res.usage.output_tokens);
        if (signal.aborted) break; // nothing of this call was written to the history

        if (res.stop_reason === 'refusal') {
          // Content is empty or a partial that must not be treated as an answer (or echoed back).
          parts.length = mark;
          save();
          notice('error', 'Claude declined to help with this request.');
          status = 'error';
          error = 'The request was declined.';
          break;
        }

        const content = echoContent(res.content);
        for (const block of content) {
          if (block.type === 'text') {
            if (!streamed) addText(block.text);
          } else if (block.type === 'tool_use' || block.type === 'server_tool_use') {
            openText = null;
            setTool(block.id, block.name, { label: toolLabel(block.name, block.input) });
          } else {
            settleServerTool(block, toolPart, setTool);
          }
        }
        save();

        // Stored exactly as it will be replayed; thinking blocks stay in place.
        if (content.length > 0) appendApi('assistant', content);
        const toolUses = content.filter((b): b is ToolUse => b.type === 'tool_use');

        if (toolUses.length === 0) {
          const paused = res.stop_reason === 'pause_turn' || res.stop_reason === 'compaction';
          if (paused && content.length > 0) continue; // a server tool is still working: send it back as is
          if (res.stop_reason === 'max_tokens') notice('info', 'The reply was cut off because it reached the length limit.');
          if (res.stop_reason === 'model_context_window_exceeded') notice('error', 'This thread has grown too long for the model. Start a project thread for new work.');
          break;
        }

        unanswered = toolUses.map((t) => t.id);
        if (res.stop_reason === 'max_tokens') {
          // A tool input cut off mid-way usually still parses; running it would act on half an instruction.
          answer(toolUses.map((t) => ({ type: 'tool_result', tool_use_id: t.id, is_error: true, content: 'Not run: the response hit the length limit before this tool call was complete.' })));
          for (const t of toolUses) setTool(t.id, t.name, { status: 'error', summary: 'Not run' });
          notice('error', 'The reply was cut off before its last step was complete, so that step was not carried out.');
          status = 'error';
          error = 'The reply was cut off.';
          break;
        }

        answer(await runTools(run, toolUses, setTool, putPart));
      }
    } catch (err) {
      if (!isAbortError(err) && !signal.aborted) {
        status = 'error';
        error = describeLlmError(err);
        if (!(err instanceof LlmCredentialsError)) console.error('[agent] turn failed', err);
      }
    }
    if (signal.aborted) status = 'cancelled';

    // Whatever happened, leave the stored state consistent. The account may be gone (deletion
    // cancels its runs), in which case there is nothing left to write to.
    try {
      if (unanswered.length > 0) answer(unanswered.map((id) => ({ type: 'tool_result', tool_use_id: id, is_error: true, content: 'cancelled' })));
      for (const p of parts) if (p.type === 'tool' && p.status === 'running') Object.assign(p, { status: status === 'ok' ? 'done' : 'error', ...(status === 'ok' ? {} : { summary: 'Stopped' }) });
      if (status === 'cancelled') parts.push({ type: 'notice', id: newId('prt'), tone: 'info', text: 'Stopped.' });
      else if (status === 'error' && error && !parts.some((p) => p.type === 'notice' && p.tone === 'error')) parts.push({ type: 'notice', id: newId('prt'), tone: 'error', text: error });
      closed = true;
      save();
      const message: ChatMessage | null = messages.get(userId, assistantId);
      if (message) publish(userId, { type: 'message.done', threadId, message });
    } catch (err) {
      closed = true;
      if (!signal.aborted) console.error('[agent] could not finalise the turn', err);
    }
    publish(userId, { type: 'run.finished', threadId, runId: run.runId, status, ...(status === 'error' && error ? { error } : {}) });
    return status;
  }

  /**
   * Run the client tool calls of one assistant message. They run concurrently, except that browser
   * handoffs go one after another. Returns exactly one result per call: if the turn is cancelled
   * while a tool is still working, that call is answered "cancelled" without waiting for it.
   */
  async function runTools(
    run: Run,
    toolUses: ToolUse[],
    setTool: (id: string, name: string, patch: Partial<ToolPart>) => void,
    putPart: (part: Exclude<MessagePart, { type: 'text' }>) => void,
  ): Promise<ToolResult[]> {
    const signal = run.abort.signal;
    const results = new Map<string, ToolResult>();
    let handoffs: Promise<void> = Promise.resolve();

    const jobs = toolUses.map((use) => {
      const ctx: ToolContext = {
        userId: run.userId, threadId: run.threadId, signal, unattended: run.unattended, handoff: deps.handoff,
        onHandoffStart: (runId) => putPart({ type: 'handoff', id: `${use.id}:handoff`, runId }),
        onApprovalCreated: (approvalId) => putPart({ type: 'approval', id: `${use.id}:approval`, approvalId }),
      };
      const exec = async () => {
        if (signal.aborted) return;
        const out = await runTool(use.name, use.input, ctx);
        if (results.has(use.id)) return; // already answered as cancelled
        results.set(use.id, { type: 'tool_result', tool_use_id: use.id, content: out.content, ...(out.isError ? { is_error: true } : {}) });
        setTool(use.id, use.name, { status: out.status ?? (out.isError ? 'error' : 'done'), summary: out.summary });
      };
      if (!isHandoffTool(use.name)) return exec();
      handoffs = handoffs.then(exec);
      return handoffs;
    });

    let onAbort: (() => void) | undefined;
    const aborted = new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      onAbort = resolve;
      signal.addEventListener('abort', onAbort, { once: true });
    });
    await Promise.race([Promise.all(jobs), aborted]);
    if (onAbort) signal.removeEventListener('abort', onAbort);

    return toolUses.map((use) => {
      const done = results.get(use.id);
      if (done) return done;
      const cancelled: ToolResult = { type: 'tool_result', tool_use_id: use.id, is_error: true, content: 'cancelled' };
      results.set(use.id, cancelled);
      setTool(use.id, use.name, { status: 'error', summary: 'Stopped' });
      return cancelled;
    });
  }

  return {
    startTurn,
    cancel(userId, threadId) {
      const run = runs.get(threadId);
      if (run && run.userId === userId) run.abort.abort();
    },
    isRunning: (threadId) => runs.has(threadId),
    cancelAll(userId) {
      for (const run of runs.values()) if (run.userId === userId) run.abort.abort();
    },
  };
}

/** A web_search / web_fetch result block arrived: finish the chip of the call it answers. */
function settleServerTool(
  block: LlmBlock,
  toolPart: (id: string) => ToolPart | undefined,
  setTool: (id: string, name: string, patch: Partial<ToolPart>) => void,
): void {
  if (block.type !== 'web_search_tool_result' && block.type !== 'web_fetch_tool_result') return;
  const part = toolPart(block.tool_use_id);
  if (!part) return;
  const c = block.content as { type?: string } | unknown[];
  const failed = !Array.isArray(c) && typeof c.type === 'string' && c.type.endsWith('error');
  const summary = failed ? 'Could not be completed' : Array.isArray(c) ? `${c.length} result${c.length === 1 ? '' : 's'}` : 'Page read';
  setTool(part.id, part.name, { status: failed ? 'error' : 'done', summary });
}
