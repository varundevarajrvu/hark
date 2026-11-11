import { afterEach, beforeEach, describe, expect, it } from 'vitest';
process.env.VECTOR_MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
import { subscribe } from '../server/core/bus.ts';
import { memories, messages, panels, resetDbForTests, tasks, threads, users } from '../server/core/db.ts';
import { AgentBusyError } from '../server/core/runtime.ts';
import type { HandoffRuntime } from '../server/core/runtime.ts';
import { vault } from '../server/core/vault.ts';
import { createAgentRuntime, createOfflineClient, textBlock, toolUseBlock } from '../server/agent/index.ts';
import type { LlmBlock, LlmClient, LlmRequest, LlmResponse } from '../server/agent/index.ts';
import type { ServerEvent } from '../shared/types.ts';

type Step = LlmBlock[] | ((req: LlmRequest) => LlmBlock[] | Promise<LlmBlock[]>);

/** An LlmClient that plays back a fixed list of responses and records everything it was given. */
function scripted(steps: Step[]) {
  const seen: Array<{ system: string; messages: any[]; tools: any[] }> = [];
  const client: LlmClient = {
    async runTurn(req): Promise<LlmResponse> {
      seen.push(JSON.parse(JSON.stringify({ system: req.system, messages: req.messages, tools: req.tools })));
      const step = steps[seen.length - 1];
      if (!step) throw new Error('script exhausted');
      const content = typeof step === 'function' ? await step(req) : step;
      for (const b of content) if (b.type === 'text') req.onTextDelta?.(b.text);
      return { content, stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn', usage: { input_tokens: 10, output_tokens: 5 }, model: 'test-model' };
    },
  };
  return { client, seen };
}

const noHandoff: HandoffRuntime = {
  run: async () => ({ runId: 'hnd_x', status: 'done', result: 'ok' }),
  screenshot: () => null,
  cancel: () => {},
  cancelAll: () => {},
};

let user: string, thread: string, events: ServerEvent[], unsubscribe: () => void;
beforeEach(() => {
  resetDbForTests();
  user = users.create({ email: 'a@x.dev', name: 'Ada', passwordHash: 'h', timezone: 'Europe/London' }).id;
  thread = threads.main(user).id;
  events = [];
  unsubscribe = subscribe(user, (e) => events.push(e));
});
afterEach(() => unsubscribe());

const history = () => messages.apiHistory(user, thread) as any[];
const visible = () => messages.list(user, thread).messages;
const ofType = <T extends ServerEvent['type']>(type: T) => events.filter((e): e is Extract<ServerEvent, { type: T }> => e.type === type);

/** Every tool_use in the stored history is answered in the very next message. */
function expectValidHistory() {
  const h = history();
  h.forEach((m, i) => {
    if (m.role !== 'assistant') return;
    const ids = (m.content as any[]).filter((b) => b.type === 'tool_use').map((b) => b.id);
    if (ids.length === 0) return;
    const next = h[i + 1];
    expect(next?.role).toBe('user');
    expect((next.content as any[]).filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id)).toEqual(ids);
  });
}

describe('orchestrator turn', () => {
  it('persists one visible assistant message and a replayable history', async () => {
    const { client, seen } = scripted([[textBlock('Hello Ada.')], [textBlock('Again.')]]);
    const agent = createAgentRuntime({ handoff: noHandoff, llm: client });

    const turn = agent.startTurn({ userId: user, threadId: thread, text: 'hi there', source: 'user' });
    expect(agent.isRunning(thread)).toBe(true);
    expect(await turn.done).toBe('ok');
    expect(agent.isRunning(thread)).toBe(false);

    const shown = visible();
    expect(shown.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(shown[0]!.parts).toMatchObject([{ type: 'text', text: 'hi there' }]);
    expect(shown[0]!.source).toBe('user');
    expect(shown[1]!.parts).toMatchObject([{ type: 'text', text: 'Hello Ada.' }]);

    const h = history();
    expect(h.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(h[0].content).toHaveLength(2);
    expect(h[0].content[0].text).toMatch(/^<context>[\s\S]*Europe\/London[\s\S]*<state>[\s\S]*User: Ada[\s\S]*<\/context>$/);
    expect(h[0].content[1]).toEqual({ type: 'text', text: 'hi there' });
    expect(h[1].content).toEqual([textBlock('Hello Ada.')]);
    // The model was given exactly the stored history, one cached-able system string, and a fixed tool list.
    expect(seen[0]!.messages).toEqual([h[0]]);
    expect(seen[0]!.tools.slice(0, 2)).toEqual([
      { type: 'web_search_20260209', name: 'web_search', max_uses: 8 },
      { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 8 },
    ]);
    expect(seen[0]!.tools.slice(2).every((t) => t.eager_input_streaming === true && t.input_schema.type === 'object')).toBe(true);

    expect(events.map((e) => e.type)).toEqual(['message.created', 'run.started', 'message.delta', 'message.done', 'run.finished']);
    expect(ofType('run.started')[0]).toMatchObject({ runId: turn.runId, messageId: shown[1]!.id });
    expect(ofType('message.done')[0]!.message.id).toBe(shown[1]!.id);
    expect(ofType('run.finished')[0]).toMatchObject({ status: 'ok' });

    // Second turn: history is replayed append-only and the unchanged state is not repeated.
    expect(await agent.startTurn({ userId: user, threadId: thread, text: 'and again' }).done).toBe('ok');
    expect(seen[1]!.messages.slice(0, 2)).toEqual(h);
    expect(seen[1]!.messages[2].content[0].text).not.toContain('<state>');
    expect(seen[1]!.system).toBe(seen[0]!.system);
    expect(seen[1]!.tools).toEqual(seen[0]!.tools);
  });

  it('runs two tool calls of one message and answers both in one user message', async () => {
    const html = '<!doctype html><html><body><script>document.body.textContent = "hi"</script></body></html>';
    const calls = [toolUseBlock('remember', { content: 'Likes oolong tea', category: 'preferences' }, 'tu_1'), toolUseBlock('create_panel', { title: 'Tea log', description: 'Cups today', html }, 'tu_2')];
    const { client } = scripted([[textBlock('On it.'), ...calls], [textBlock('Both done.')]]);
    const agent = createAgentRuntime({ handoff: noHandoff, llm: client });
    expect(await agent.startTurn({ userId: user, threadId: thread, text: 'remember tea and make a panel' }).done).toBe('ok');

    expect(memories.list(user).map((m) => m.content)).toEqual(['Likes oolong tea']);
    expect(panels.list(user).map((p) => p.title)).toEqual(['Tea log']);

    const h = history();
    expect(h.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(h[1].content).toEqual([textBlock('On it.'), ...calls]);
    expect(h[2].content.map((b: any) => [b.type, b.tool_use_id, b.is_error])).toEqual([['tool_result', 'tu_1', undefined], ['tool_result', 'tu_2', undefined]]);
    expectValidHistory();

    expect(ofType('invalidate').map((e) => e.resource).sort()).toEqual(['memories', 'panels']);
    const shown = visible();
    expect(shown).toHaveLength(2); // hidden plumbing stays hidden
    expect(shown[1]!.parts).toMatchObject([
      { type: 'text', text: 'On it.' },
      { type: 'tool', id: 'tu_1', name: 'remember', label: 'Saving a memory', status: 'done' },
      { type: 'tool', id: 'tu_2', name: 'create_panel', label: 'Creating panel “Tea log”', status: 'done' },
      { type: 'text', text: 'Both done.' },
    ]);
    expect(ofType('message.part').some((e) => e.part.type === 'tool' && e.part.status === 'running')).toBe(true);
  });

  it('returns an is_error result for invalid tool input and carries on', async () => {
    const { client, seen } = scripted([[toolUseBlock('remember', { content: 42 }, 'tu_bad')], [textBlock('Let me try that differently.')]]);
    const agent = createAgentRuntime({ handoff: noHandoff, llm: client });
    expect(await agent.startTurn({ userId: user, threadId: thread, text: 'remember something' }).done).toBe('ok');
    const result = history()[2].content[0];
    expect(result).toMatchObject({ type: 'tool_result', tool_use_id: 'tu_bad', is_error: true });
    expect(result.content).toContain('INVALID_INPUT');
    expect(memories.list(user)).toHaveLength(0);
    expect(seen).toHaveLength(2);
    expect(visible()[1]!.parts[0]).toMatchObject({ type: 'tool', status: 'error' });
  });

  it('rejects a second turn on a busy thread and another user’s thread', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { client } = scripted([async () => (await gate, [textBlock('done')])]);
    const agent = createAgentRuntime({ handoff: noHandoff, llm: client });
    const turn = agent.startTurn({ userId: user, threadId: thread, text: 'one' });
    expect(() => agent.startTurn({ userId: user, threadId: thread, text: 'two' })).toThrow(AgentBusyError);
    release();
    expect(await turn.done).toBe('ok');
    expect(visible().filter((m) => m.role === 'user')).toHaveLength(1);

    const other = users.create({ email: 'b@x.dev', name: 'B', passwordHash: 'h' }).id;
    expect(() => agent.startTurn({ userId: other, threadId: thread, text: 'mine now' })).toThrow();
  });

  it('cancels mid-run, ends cancelled and leaves every tool_use answered', async () => {
    let started!: () => void;
    const running = new Promise<void>((r) => (started = r));
    const stuck: HandoffRuntime = {
      ...noHandoff,
      run: (opts) => {
        opts.onStart?.('hnd_live');
        started();
        return new Promise(() => {}); // never settles, even when aborted
      },
    };
    const { client } = scripted([[toolUseBlock('handoff', { goal: 'look something up' }, 'tu_h'), toolUseBlock('remember', { content: 'x' }, 'tu_m')]]);
    const agent = createAgentRuntime({ handoff: stuck, llm: client });
    const turn = agent.startTurn({ userId: user, threadId: thread, text: 'go' });
    await running;
    agent.cancel('someone-else', thread);
    expect(agent.isRunning(thread)).toBe(true);
    agent.cancel(user, thread);
    expect(await turn.done).toBe('cancelled');

    expectValidHistory();
    const results = history()[2].content;
    expect(results[0]).toMatchObject({ tool_use_id: 'tu_h', is_error: true, content: 'cancelled' });
    expect(results[1].is_error).toBeUndefined(); // the memory write had already happened
    const parts = visible()[1]!.parts;
    expect(parts).toContainEqual(expect.objectContaining({ type: 'handoff', runId: 'hnd_live' }));
    expect(parts.at(-1)).toMatchObject({ type: 'notice', text: 'Stopped.' });
    expect(parts.some((p) => p.type === 'tool' && p.status === 'running')).toBe(false);
    expect(ofType('run.finished')[0]).toMatchObject({ status: 'cancelled' });
    expect(agent.isRunning(thread)).toBe(false);
  });

  it('refuses memory tools when memory is switched off', async () => {
    const kept = memories.create(user, 'Existing fact');
    users.update(user, { settings: { memoryEnabled: false } });
    const { client, seen } = scripted([[toolUseBlock('remember', { content: 'New fact' }, 'tu_1'), toolUseBlock('forget_memory', { memory_id: kept.id }, 'tu_2')], [textBlock('Memory is off.')]]);
    const agent = createAgentRuntime({ handoff: noHandoff, llm: client });
    expect(await agent.startTurn({ userId: user, threadId: thread, text: 'remember this' }).done).toBe('ok');
    for (const r of history()[2].content) {
      expect(r.is_error).toBe(true);
      expect(r.content).toContain('switched off');
    }
    expect(memories.list(user).map((m) => m.content)).toEqual(['Existing fact']);
    // With memory off the model is not shown the memories either.
    expect(JSON.stringify(seen)).not.toContain('Existing fact');
    expect(ofType('invalidate')).toHaveLength(0);
  });

  it('shows vault labels to the model but never a secret', async () => {
    vault.create(user, { kind: 'login', label: 'Grocer account', origin: 'shop.example.com', username: 'ada.private@x.dev', password: 'pw-Zebra-Quartz-91' });
    vault.create(user, { kind: 'card', label: 'Everyday card', number: '4242 4242 4242 4242', expMonth: '08', expYear: '2031', cvc: '737', nameOnCard: 'Ada L' });
    const { client, seen } = scripted([[toolUseBlock('list_tasks', {}, 'tu_1')], [textBlock('ok')]]);
    const agent = createAgentRuntime({ handoff: noHandoff, llm: client });
    expect(await agent.startTurn({ userId: user, threadId: thread, text: 'what logins do I have saved?' }).done).toBe('ok');
    const given = JSON.stringify(seen) + JSON.stringify(history()) + JSON.stringify(events);
    expect(given).toContain('Grocer account');
    expect(given).toContain('https://shop.example.com');
    expect(given).toContain('Everyday card');
    for (const secret of ['pw-Zebra-Quartz-91', 'ada.private@x.dev', '4242424242424242', '4242 4242', '737']) expect(given).not.toContain(secret);
  });

  it('rejects panel html that loads external code', async () => {
    const bad = (html: string, id: string) => toolUseBlock('create_panel', { title: 'Bad', description: '', html }, id);
    const { client } = scripted([
      [bad('<html><script src="https://cdn.example/x.js"></script></html>', 'tu_1'), bad('<LINK rel=stylesheet href=x>', 'tu_2'), bad('<iframe></iframe>', 'tu_3'), bad('<meta http-equiv="refresh" content="0">', 'tu_4'), bad('x'.repeat(200 * 1024 + 1), 'tu_5')],
      [textBlock('Could not.')],
    ]);
    const agent = createAgentRuntime({ handoff: noHandoff, llm: client });
    expect(await agent.startTurn({ userId: user, threadId: thread, text: 'panel please' }).done).toBe('ok');
    expect(history()[2].content.map((r: any) => r.is_error)).toEqual([true, true, true, true, true]);
    expect(panels.list(user)).toHaveLength(0);
  });

  it('validates schedules and reports a failed model call without leaking details', async () => {
    const { client } = scripted([
      [toolUseBlock('schedule_task', { title: 'Too often', prompt: 'p', cron: '* * * * *' }, 'tu_1'), toolUseBlock('schedule_task', { title: 'Morning brief', prompt: 'p', cron: '0 8 * * 1-5' }, 'tu_2')],
      () => {
        throw new Error('request req_011CSecretId failed at /internal/path');
      },
    ]);
    const agent = createAgentRuntime({ handoff: noHandoff, llm: client });
    expect(await agent.startTurn({ userId: user, threadId: thread, text: 'schedule' }).done).toBe('error');
    expect(tasks.list(user).map((t) => [t.title, t.timezone, Boolean(t.nextRunAt)])).toEqual([['Morning brief', 'Europe/London', true]]);
    expectValidHistory();
    const finished = ofType('run.finished')[0]!;
    expect(finished.status).toBe('error');
    expect(JSON.stringify([finished, visible()])).not.toMatch(/req_011|internal\/path/);
    expect(visible()[1]!.parts.at(-1)).toMatchObject({ type: 'notice', tone: 'error' });
  });

  it('works end to end with the offline model', async () => {
    const agent = createAgentRuntime({ handoff: noHandoff, llm: createOfflineClient() });
    expect(await agent.startTurn({ userId: user, threadId: thread, text: 'Remember that I take my coffee black' }).done).toBe('ok');
    expect(memories.list(user).map((m) => m.content)).toEqual(['I take my coffee black']);
    expect(await agent.startTurn({ userId: user, threadId: thread, text: 'make me a habit tracker panel' }).done).toBe('ok');
    expect(panels.list(user)).toHaveLength(1);
    expect(await agent.startTurn({ userId: user, threadId: thread, text: 'what is the capital of France?' }).done).toBe('ok');
    expect(JSON.stringify(visible().at(-1)!.parts)).toContain('offline demo model');
    expectValidHistory();
  });
});
