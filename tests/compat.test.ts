import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LlmClient, LlmMessage, LlmTool } from '../server/agent/llm.ts';

// A stand-in for Gemini / Groq: an OpenAI-style chat-completions endpoint that streams SSE.
let server: http.Server;
let client: LlmClient;
let mod: typeof import('../server/agent/openai-compat.ts');
let llm: typeof import('../server/agent/llm.ts');
const seen: any[] = [];
let reply: (body: any) => { status?: number; chunks?: unknown[]; raw?: string } = () => ({ chunks: [] });

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (d) => (data += d));
    req.on('end', () => {
      const body = JSON.parse(data);
      seen.push({ body, auth: req.headers.authorization, url: req.url });
      const r = reply(body);
      if (r.status && r.status !== 200) {
        res.writeHead(r.status, { 'content-type': 'application/json' });
        return res.end(r.raw ?? '{"error":{"message":"nope sk-secret-detail"}}');
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const c of r.chunks ?? []) res.write(`data: ${JSON.stringify(c)}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  process.env.VECTOR_PROVIDER = 'openai-compatible';
  process.env.VECTOR_OPENAI_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/`;
  process.env.VECTOR_OPENAI_API_KEY = 'test-key';
  process.env.VECTOR_MODEL = 'test-model';
  mod = await import('../server/agent/openai-compat.ts');
  llm = await import('../server/agent/llm.ts');
  client = mod.createOpenAiCompatClient();
});
afterAll(() => server.close());

const tools: LlmTool[] = [
  { name: 'remember', description: 'Save a memory', input_schema: { $schema: 'x', type: 'object', properties: { content: { type: 'string', default: '' } }, required: ['content'], additionalProperties: false } } as LlmTool,
  { type: 'web_search_20260209', name: 'web_search', max_uses: 8 } as LlmTool,
];
const run = (messages: LlmMessage[], onTextDelta?: (t: string) => void) =>
  client.runTurn({ system: 'SYS', messages, tools, signal: new AbortController().signal, onTextDelta });

describe('OpenAI-compatible client', () => {
  it('streams text and reports usage', async () => {
    reply = () => ({ chunks: [
      { model: 'm-1', choices: [{ delta: { content: 'Hel' } }] },
      { choices: [{ delta: { content: 'lo' }, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } },
    ] });
    const deltas: string[] = [];
    const res = await run([{ role: 'user', content: 'hi' }], (t) => deltas.push(t));
    expect(deltas).toEqual(['Hel', 'lo']);
    expect(res).toMatchObject({ stop_reason: 'end_turn', model: 'm-1', usage: { input_tokens: 12, output_tokens: 3 } });
    expect(res.content).toEqual([{ type: 'text', text: 'Hello', citations: null }]);
    const sent = seen.at(-1);
    expect(sent.url).toBe('/v1/chat/completions');
    expect(sent.auth).toBe('Bearer test-key');
    expect(sent.body.model).toBe('test-model');
    expect(sent.body.messages[0].role).toBe('system');
    expect(sent.body.messages[0].content).toContain('web search and web fetch tools are not available');
    // Hosted tools dropped, schema cleaned of keywords Gemini rejects.
    expect(sent.body.tools).toHaveLength(1);
    expect(JSON.stringify(sent.body.tools)).not.toMatch(/\$schema|additionalProperties|default/);
  });

  it('assembles tool calls streamed in pieces and keeps provider extras for the echo', async () => {
    reply = () => ({ chunks: [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'remember', arguments: '{"con' }, extra_content: { google: { thought_signature: 'SIG' } } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'tent":"veg"}' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 1, function: { name: 'remember', arguments: '{"content":"b"}' } }] }, finish_reason: 'tool_calls' }] },
    ] });
    const res = await run([{ role: 'user', content: 'remember' }]);
    expect(res.stop_reason).toBe('tool_use');
    expect(res.content[0]).toMatchObject({ type: 'tool_use', id: 'call_1', name: 'remember', input: { content: 'veg' }, _extra: { google: { thought_signature: 'SIG' } } });
    expect(res.content[1]).toMatchObject({ type: 'tool_use', name: 'remember', input: { content: 'b' } });
    expect((res.content[1] as any).id).toMatch(/^call_/); // provider sent no id

    // Second request: the history round-trips as assistant tool_calls + tool messages, extras echoed.
    reply = () => ({ chunks: [{ choices: [{ delta: { content: 'Saved.' }, finish_reason: 'stop' }] }] });
    const id2 = (res.content[1] as any).id;
    await run([
      { role: 'user', content: [{ type: 'text', text: '<context>x</context>' }, { type: 'text', text: 'remember' }] },
      { role: 'assistant', content: res.content as any },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'call_1', content: 'ok' },
        { type: 'tool_result', tool_use_id: id2, content: [{ type: 'text', text: 'bad' }], is_error: true },
      ] },
    ]);
    const msgs = seen.at(-1).body.messages;
    expect(msgs.map((m: any) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'tool']);
    expect(msgs[2].tool_calls[0]).toMatchObject({ id: 'call_1', extra_content: { google: { thought_signature: 'SIG' } }, function: { name: 'remember', arguments: '{"content":"veg"}' } });
    expect(msgs[3]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'ok' });
    expect(msgs[4].content).toBe('ERROR: bad');
  });

  it('skips Claude-only blocks when a thread started on Claude', () => {
    const msgs = mod.toChatMessages('S', [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text: 'a' }] as any },
    ]);
    expect(msgs).toEqual([{ role: 'system', content: 'S' }, { role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }]);
  });

  it('reports truncation and unparseable arguments safely', async () => {
    reply = () => ({ chunks: [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'remember', arguments: '{"content":"ve' } }] }, finish_reason: 'length' }] }] });
    const res = await run([{ role: 'user', content: 'x' }]);
    expect(res.stop_reason).toBe('max_tokens');
    expect(res.content[0]).toMatchObject({ type: 'tool_use', input: {} });
  });

  it('maps failures to user-safe notices without leaking provider detail', async () => {
    reply = () => ({ status: 401 });
    await expect(run([{ role: 'user', content: 'x' }])).rejects.toBeInstanceOf(llm.LlmCredentialsError);
    reply = () => ({ status: 404 });
    const err = await run([{ role: 'user', content: 'x' }]).catch((e) => e);
    expect(err).toBeInstanceOf(llm.LlmHttpError);
    const notice = llm.describeLlmError(err);
    expect(notice).toContain('test-model');
    expect(notice).not.toContain('sk-secret-detail');
    expect(llm.describeLlmError(new llm.LlmHttpError(429, 'x'))).toMatch(/quota|rate limit/);
  });
});
