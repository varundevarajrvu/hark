import { config } from '../core/config.ts';
import { createAnthropicClient, textBlock, toolUseBlock } from './llm.ts';
import type { LlmBlock, LlmClient, LlmMessage, LlmRequest, LlmResponse } from './llm.ts';

/**
 * The offline model: a deterministic, keyword-driven stand-in used when VECTOR_MOCK_LLM=1 and by
 * tests. It returns the same shapes as the API (content blocks, stop_reason, usage) so the whole
 * product can be exercised without credentials. It is stateless: every decision is read off the
 * conversation it is given.
 */

export function defaultLlm(): LlmClient {
  return config.mockLlm ? createOfflineClient() : createAnthropicClient();
}

export function createOfflineClient(): LlmClient {
  return {
    async runTurn(req) {
      const isBrowserAgent = req.tools.some((t) => 'name' in t && t.name === 'finish');
      const content = isBrowserAgent ? browserScript(req.messages) : orchestratorScript(req.messages);
      for (const block of content) {
        if (block.type !== 'text') continue;
        for (const chunk of chunks(block.text)) {
          await sleep(15, req.signal);
          req.onTextDelta?.(chunk);
        }
      }
      for (const block of content) {
        if (block.type === 'tool_use') req.onToolStart?.({ id: block.id, name: block.name, server: false });
      }
      return respond(req, content);
    },
  };
}

function respond(req: LlmRequest, content: LlmBlock[]): LlmResponse {
  const words = (s: string) => Math.ceil(s.length / 4);
  return {
    content,
    stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
    usage: { input_tokens: words(JSON.stringify(req.messages)), output_tokens: words(JSON.stringify(content)) },
    model: 'offline-demo',
  };
}

function chunks(text: string): string[] {
  const size = Math.max(12, Math.ceil(text.length / 4));
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
function abortError(): Error {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}

// ───────────────────────── reading the conversation ─────────────────────────

type AnyBlock = { type: string; text?: string; content?: unknown; is_error?: boolean };

function blocksOf(message: LlmMessage | undefined): AnyBlock[] {
  if (!message) return [];
  return typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : (message.content as AnyBlock[]);
}

/** The last thing the user typed: the final text block of the latest user message that has one. */
function lastUserText(messages: LlmMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== 'user') continue;
    const texts = blocksOf(m).filter((b) => b.type === 'text');
    if (texts.length > 0) return texts[texts.length - 1]!.text ?? '';
  }
  return '';
}

function toolResults(message: LlmMessage | undefined): Array<{ text: string; isError: boolean }> {
  return blocksOf(message)
    .filter((b) => b.type === 'tool_result')
    .map((b) => ({
      isError: b.is_error === true,
      text: typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map((c: AnyBlock) => c.text ?? '').join('\n') : '',
    }));
}

const URL_RE = /https?:\/\/[^\s<>"')]+/i;

// ───────────────────────── orchestrator script ─────────────────────────

function orchestratorScript(messages: LlmMessage[]): LlmBlock[] {
  const last = messages[messages.length - 1];
  const results = toolResults(last);
  if (results.length > 0) {
    const failed = results.filter((r) => r.isError);
    if (failed.length > 0) return [textBlock(`That did not work: ${failed[0]!.text.slice(0, 300)}`)];
    const report = /<handoff_report[^>]*>([\s\S]*?)<\/handoff_report>/.exec(results[0]!.text);
    if (report) return [textBlock(`The browser agent finished. Its report:\n\n${report[1]!.trim()}`)];
    return [textBlock('Done. (Offline demo model: the action above really ran; the wording is scripted.)')];
  }

  const text = lastUserText(messages).trim();
  const lower = text.toLowerCase();
  const url = URL_RE.exec(text)?.[0];

  const remember = /\bremember\s+(?:that\s+)?(.+)/is.exec(text);
  if (remember && !/\bremind me\b/.test(lower)) {
    return [textBlock('Noting that down.'), toolUseBlock('remember', { content: remember[1]!.trim().slice(0, 500), category: 'general' })];
  }
  if (/\bforget\b/.test(lower)) {
    const id = /\bmem_[A-Za-z0-9_-]+/.exec(text)?.[0];
    if (id) return [toolUseBlock('forget_memory', { memory_id: id })];
    return [textBlock('Tell me which memory to forget by its id (for example "forget mem_abc"), or remove it on the Memory screen. The offline demo model cannot look memories up by meaning.')];
  }
  if (/\b(panel|dashboard|tracker)\b/.test(lower)) {
    return [
      textBlock('Putting a small habit tracker on your Home screen.'),
      toolUseBlock('create_panel', { title: 'Habit tracker', description: 'Tick off today’s habits; the count updates as you go.', html: DEMO_PANEL_HTML }),
    ];
  }
  if (/\b(every|daily|remind me)\b/.test(lower)) {
    const hour = /\b(\d{1,2})\s*(am|pm)\b/.exec(lower);
    let h = hour ? Number(hour[1]) % 12 : 9;
    if (hour?.[2] === 'pm') h += 12;
    const weekly = /\bevery (week|monday)\b/.test(lower);
    return [
      textBlock('Scheduling that.'),
      toolUseBlock('schedule_task', { title: text.slice(0, 60), prompt: text, cron: weekly ? `0 ${h} * * 1` : `0 ${h} * * *` }),
    ];
  }
  if (/\b(action|todo|to-do|bill)\b/.test(lower)) {
    const bill = /\bbill\b/.test(lower);
    return [
      textBlock('Adding a button to your Home screen.'),
      toolUseBlock('create_action', {
        verb: bill ? 'Pay' : 'Do',
        title: text.slice(0, 60),
        detail: 'Created by the offline demo model.',
        prompt: text,
        priority: bill ? 1 : 2,
      }),
    ];
  }
  if (url || /\b(browse|go to|open)\b/.test(lower)) {
    return [textBlock('Handing this to the browser agent.'), toolUseBlock('handoff', url ? { goal: text, start_url: url } : { goal: text })];
  }
  return [
    textBlock(
      'This is the offline demo model, not Claude, so I cannot actually answer that. I can demonstrate the product: ' +
        'say "remember that …" to save a memory, ask for a "panel" or "tracker", "remind me every day at 9am …" to schedule a task, ' +
        'mention a "todo" or a "bill" to get an action button, or give me a URL to send the browser agent to. ' +
        'Real answers need Claude API credentials on the server (set ANTHROPIC_API_KEY and unset VECTOR_MOCK_LLM).',
    ),
  ];
}

// ───────────────────────── browser-agent script: navigate → snapshot → finish ─────────────────────────

function browserScript(messages: LlmMessage[]): LlmBlock[] {
  const turns = messages.filter((m) => m.role === 'assistant').length;
  const last = toolResults(messages[messages.length - 1])[0];
  if (turns === 0) {
    const url = URL_RE.exec(lastUserText(messages.slice(0, 1)))?.[0];
    if (!url) return [toolUseBlock('finish', { result: 'The offline demo model needs a URL in the goal to open a page.', success: false })];
    return [toolUseBlock('navigate', { url })];
  }
  if (last?.isError) return [toolUseBlock('finish', { result: `Could not complete this: ${last.text.slice(0, 400)}`, success: false })];
  if (turns === 1) return [toolUseBlock('snapshot', {})];
  const snap = last?.text ?? '';
  const title = /^Title: (.*)$/m.exec(snap)?.[1] ?? '(no title)';
  const body = snap.split(/^Visible text:\n/m)[1] ?? '';
  const lines = body.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 5).join('\n');
  return [toolUseBlock('finish', { result: `Opened the page “${title}”. It begins:\n${lines}`, success: true })];
}

// ───────────────────────── demo panel ─────────────────────────

const DEMO_PANEL_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Habit tracker</title>
<style>
  :root { color-scheme: light dark; --bg:#fff; --fg:#15171a; --muted:#6b7280; --line:#e5e7eb; --accent:#2563eb; }
  @media (prefers-color-scheme: dark) { :root { --bg:#15171a; --fg:#f3f4f6; --muted:#9ca3af; --line:#2c3037; --accent:#60a5fa; } }
  * { box-sizing: border-box; }
  body { margin:0; padding:14px 16px; font:14px/1.4 system-ui, sans-serif; background:var(--bg); color:var(--fg); }
  h1 { font-size:15px; margin:0 0 2px; }
  p { margin:0 0 10px; color:var(--muted); font-size:12px; }
  label { display:flex; align-items:center; gap:10px; padding:7px 0; border-top:1px solid var(--line); cursor:pointer; }
  input { width:18px; height:18px; accent-color:var(--accent); }
  label.done span { text-decoration:line-through; color:var(--muted); }
  .bar { height:6px; border-radius:3px; background:var(--line); overflow:hidden; margin-top:10px; }
  .bar i { display:block; height:100%; width:0; background:var(--accent); transition:width .2s; }
</style></head>
<body>
  <h1>Today</h1>
  <p id="count"></p>
  <div id="list"></div>
  <div class="bar"><i id="fill"></i></div>
  <script>
    const habits = ['Drink water', 'Move for 20 minutes', 'Read 10 pages', 'Lights out by 11'];
    const done = new Set();
    const list = document.getElementById('list');
    function render() {
      document.getElementById('count').textContent = done.size + ' of ' + habits.length + ' done';
      document.getElementById('fill').style.width = (100 * done.size / habits.length) + '%';
    }
    habits.forEach(function (name, i) {
      const row = document.createElement('label');
      const box = document.createElement('input');
      box.type = 'checkbox';
      const text = document.createElement('span');
      text.textContent = name;
      box.addEventListener('change', function () {
        if (box.checked) done.add(i); else done.delete(i);
        row.classList.toggle('done', box.checked);
        render();
      });
      row.append(box, text);
      list.append(row);
    });
    render();
  </script>
</body></html>`;
