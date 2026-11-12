import { randomBytes } from 'node:crypto';
import { config, hasLlmCredentials } from '../core/config.ts';
import { LlmCredentialsError, LlmHttpError } from './llm.ts';
import type { LlmBlock, LlmClient, LlmMessage, LlmRequest, LlmResponse, LlmTool } from './llm.ts';

/**
 * Model client for providers that speak the OpenAI chat-completions API: Gemini and Groq (both
 * have free tiers), or any compatible server such as Ollama. The rest of the product keeps using
 * Claude-shaped messages; this file translates on the way out and on the way back.
 *
 * What does not carry over from the Claude client: the hosted web_search / web_fetch tools (the
 * model is told to use the browser agent instead), prompt caching, refusal fallback and compaction.
 * The consent, vault and network guards live in the tools, not the model, so they are unaffected.
 */

interface ChatToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
  /** Provider extras that must be echoed back with the call (Gemini thought signatures). */
  extra_content?: unknown;
}
type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

/** A tool_use block as stored in history, plus what the provider asked us to send back. */
type StoredToolUse = Extract<LlmBlock, { type: 'tool_use' }> & { _extra?: unknown };

const NO_WEB_TOOLS =
  '\n\nIn this deployment the web search and web fetch tools are not available. To read or look something up on the web, use the browser agent (handoff) with a concrete goal, and say plainly when you are answering from memory instead.';

function blockText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (b && typeof b === 'object' && (b as { type?: string }).type === 'text' ? String((b as { text?: unknown }).text ?? '') : '')).filter(Boolean).join('\n');
}

/** Claude-shaped history → chat-completions messages. Blocks with no equivalent (thinking, server tools) are dropped. */
export function toChatMessages(system: string, messages: LlmMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'system' || m.content === undefined) continue;
    if (typeof m.content === 'string') {
      out.push(m.role === 'assistant' ? { role: 'assistant', content: m.content } : { role: 'user', content: m.content });
      continue;
    }
    if (m.role === 'assistant') {
      const text = m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('');
      const calls = m.content.filter((b) => b.type === 'tool_use').map((b): ChatToolCall => {
        const use = b as StoredToolUse;
        return {
          id: use.id, type: 'function',
          function: { name: use.name, arguments: JSON.stringify(use.input ?? {}) },
          ...(use._extra !== undefined ? { extra_content: use._extra } : {}),
        };
      });
      if (!text && calls.length === 0) continue;
      out.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    // A user turn: tool results first (they must directly follow the assistant's calls), then any text.
    const texts: string[] = [];
    for (const b of m.content) {
      if (b.type === 'tool_result') {
        const body = blockText(b.content) || '(no output)';
        out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: b.is_error ? `ERROR: ${body}` : body });
      } else if (b.type === 'text') texts.push(b.text);
    }
    if (texts.length) out.push({ role: 'user', content: texts.join('\n\n') });
  }
  return out;
}

/** Keep only JSON-Schema keywords every provider accepts. Gemini rejects `$schema` and friends. */
function cleanSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(cleanSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === '$schema' || k === 'additionalProperties' || k === 'propertyNames' || k === '$id' || k === '$defs' || k === 'default') continue;
    out[k] = k === 'properties' && v && typeof v === 'object'
      ? Object.fromEntries(Object.entries(v).map(([name, sub]) => [name, cleanSchema(sub)]))
      : cleanSchema(v);
  }
  return out;
}

/** Only our own function tools translate; Claude's hosted tools are left out. */
export function toChatTools(tools: LlmTool[]): unknown[] {
  return tools.flatMap((t) => {
    if (!('input_schema' in t) || !('name' in t)) return [];
    return [{ type: 'function', function: { name: t.name, description: 'description' in t ? (t.description ?? '') : '', parameters: cleanSchema(t.input_schema) } }];
  });
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason ?? new DOMException('Aborted', 'AbortError')); }, { once: true });
  });

const MAX_OUTPUT_TOKENS = 8192;
/** Free tiers throttle by the minute: wait these long before giving up on a 429 or a 5xx. */
const RETRY_DELAYS_MS = [4_000, 15_000];

export function createOpenAiCompatClient(): LlmClient {
  return {
    async runTurn(req: LlmRequest): Promise<LlmResponse> {
      if (!hasLlmCredentials()) throw new LlmCredentialsError();
      const tools = toChatTools(req.tools);
      const droppedWebTools = req.tools.some((t) => !('input_schema' in t));
      const body = JSON.stringify({
        model: config.model,
        messages: toChatMessages(req.system + (droppedWebTools ? NO_WEB_TOOLS : ''), req.messages),
        ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
        max_tokens: MAX_OUTPUT_TOKENS,
        stream: true,
        stream_options: { include_usage: true },
      });

      for (let attempt = 0; ; attempt++) {
        const res = await fetch(`${config.compatBaseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(config.compatApiKey ? { authorization: `Bearer ${config.compatApiKey}` } : {}) },
          body,
          signal: req.signal,
        });
        if (res.ok && res.body) return readStream(res.body, req);
        const detail = (await res.text().catch(() => '')).slice(0, 2000);
        if (res.status === 401 || res.status === 403) throw new LlmCredentialsError();
        const retryable = res.status === 429 || res.status >= 500;
        const delay = RETRY_DELAYS_MS[attempt];
        if (!retryable || delay === undefined) throw new LlmHttpError(res.status, detail);
        await sleep(delay, req.signal);
      }
    },
  };
}

async function readStream(stream: ReadableStream<Uint8Array>, req: LlmRequest): Promise<LlmResponse> {
  let text = '';
  let finish: string | null = null;
  let model = config.model;
  const usage = { input_tokens: 0, output_tokens: 0 };
  const calls: Array<{ id: string; name: string; args: string; extra?: unknown; announced: boolean }> = [];

  const handle = (data: string) => {
    if (data === '[DONE]') return;
    let chunk: any;
    try {
      chunk = JSON.parse(data);
    } catch {
      return; // keep-alives and partial frames
    }
    if (chunk.error) throw new LlmHttpError(Number(chunk.error.code) || 500, JSON.stringify(chunk.error).slice(0, 2000));
    if (typeof chunk.model === 'string') model = chunk.model;
    if (chunk.usage) {
      usage.input_tokens = chunk.usage.prompt_tokens ?? usage.input_tokens;
      usage.output_tokens = chunk.usage.completion_tokens ?? usage.output_tokens;
    }
    const choice = chunk.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) finish = choice.finish_reason;
    const delta = choice.delta ?? {};
    if (typeof delta.content === 'string' && delta.content) {
      text += delta.content;
      req.onTextDelta?.(delta.content);
    }
    for (const tc of delta.tool_calls ?? []) {
      // Providers differ: some send an index per call and stream arguments in pieces, some send whole calls.
      const i = typeof tc.index === 'number' ? tc.index : calls.length;
      const call = (calls[i] ??= { id: '', name: '', args: '', announced: false });
      if (tc.id) call.id = tc.id;
      if (tc.function?.name) call.name = tc.function.name;
      if (typeof tc.function?.arguments === 'string') call.args += tc.function.arguments;
      if (tc.extra_content !== undefined) call.extra = tc.extra_content;
      if (!call.announced && call.name) {
        call.id ||= `call_${randomBytes(9).toString('base64url')}`;
        call.announced = true;
        req.onToolStart?.({ id: call.id, name: call.name, server: false });
      }
    }
  };

  const decoder = new TextDecoder();
  let buffer = '';
  for await (const part of stream as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(part, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line.startsWith('data:')) handle(line.slice(5).trim());
    }
  }
  if (buffer.trim().startsWith('data:')) handle(buffer.trim().slice(5).trim());

  const content: LlmBlock[] = [];
  if (text) content.push({ type: 'text', text, citations: null });
  const made = calls.filter((c) => c && c.name);
  for (const c of made) {
    let input: unknown = {};
    try {
      input = c.args.trim() ? JSON.parse(c.args) : {};
    } catch {
      // Unparseable arguments: leave the input empty. The tool's own schema check then returns an
      // error result to the model, which is the same path as any other invalid input.
      input = {};
    }
    const block: StoredToolUse = { type: 'tool_use', id: c.id || `call_${randomBytes(9).toString('base64url')}`, name: c.name, input };
    if (c.extra !== undefined) block._extra = c.extra;
    content.push(block);
  }
  // A cut-off reply that contains tool calls must be reported as max_tokens so the caller does not run them.
  const stop_reason: LlmResponse['stop_reason'] = finish === 'length' ? 'max_tokens' : made.length > 0 ? 'tool_use' : 'end_turn';
  return { content, stop_reason, usage, model };
}
