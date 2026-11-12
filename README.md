# Vector

A self-hosted personal agent. One persistent chat thread that does things: it remembers, puts
one-tap action buttons and small generated panels on your Home screen, runs scheduled tasks, and
hands goals to a browser agent that drives a real Chromium while you watch and approve.

You run the server on a laptop or a VPS. The phone UI is served by the server; the Android app
(`android/`) is a thin shell that loads it. See [docs/android.md](docs/android.md).

## Run it

Needs Node 22.13+.

```bash
npm ci
npm run build
```

With the scripted offline model (no API key, good for a first look):

```bash
VECTOR_MOCK_LLM=1 npm start
```

With a free model (Google Gemini free tier; get a key at https://aistudio.google.com/apikey):

```bash
GEMINI_API_KEY=... npm start
```

With Claude (paid, the strongest option):

```bash
ANTHROPIC_API_KEY=sk-ant-... npm start
```

### Model providers

| Provider | Set | Default model | Cost |
|---|---|---|---|
| Google Gemini | `GEMINI_API_KEY` | `gemini-3.8-flash` | Free tier, rate-limited. Google uses free-tier content to improve its products. |
| Groq | `GROQ_API_KEY` | `openai/gpt-oss-120b` | Free tier, tight per-minute token limits. |
| Claude | `ANTHROPIC_API_KEY` | `claude-fable-5-2` | Paid per token. |
| Any OpenAI-compatible server | `VECTOR_OPENAI_BASE_URL`, `VECTOR_MODEL` | none | Yours (Ollama, OpenRouter…). |

`VECTOR_MODEL` overrides the default; `VECTOR_PROVIDER` picks one when several keys are set.
With a non-Claude provider there is no hosted web search or fetch (the browser agent is used
instead), no prompt caching and no automatic compaction of long threads. The approval, vault and
network guards are enforced in code and are the same on every provider.

Then open http://127.0.0.1:8787. To reach it from a phone on the same Wi-Fi, start it with
`HOST=0.0.0.0` and open `http://<laptop-ip>:8787`.

The browser agent needs Chromium. Install one that matches the pinned Playwright version:

```bash
npx playwright-core install chromium
```

or point `VECTOR_CHROMIUM_PATH` at an existing binary. All settings are listed in `.env.example`.

## How it is put together

| Part | Where | What it does |
|---|---|---|
| Contract | `shared/types.ts` | Every type and route that crosses the HTTP/SSE boundary |
| Core | `server/core/` | SQLite schema and queries, vault crypto, approval gate, event bus |
| HTTP | `server/http/` | Auth, REST routes, Server-Sent Events, scheduler |
| Agent | `server/agent/` | The chat agent: tool loop, tools, model clients (Claude, OpenAI-compatible, offline) |
| Browser agent | `server/handoff/` | Drives Chromium toward a goal, one fresh browser per run |
| Phone UI | `web/` | React client, phone-first |
| Android | `android/` | WebView shell that loads your server |


## Security model

- **Vault.** Saved logins and cards are stored as AES-256-GCM ciphertext under a per-user key
  derived from a server master key. No route returns a secret, and the model never sees one: the
  browser agent types the value straight into the page, and it is scrubbed from everything sent
  back to the model.
- **Consent.** Spending money, sending something in your name, sharing personal data, changing an
  account or using a vault item waits for your approval. The browser agent also refuses, in code,
  to click pay / order / send / submit-style buttons without a recent approval.
- **Logins only go where they belong.** A saved login fills only on its own site.
- **Browser isolation.** Each run gets a fresh browser that is discarded afterwards, and it
  cannot reach private or local network addresses.
- **Panels** are model-written HTML, shown in a sandboxed frame with no network and no access to
  your session.
- **Untrusted content.** Web pages and browser-agent reports are treated as data, not instructions.
- Sessions are httpOnly SameSite=Strict cookies; passwords are scrypt-hashed; everything sensitive
  is written to an activity log you can read in Settings.

Known limits: the consent guard on buttons is a word-match heuristic, so a submit button labelled
"Continue" is not gated; the browser agent cannot see inside iframes; there are no Gmail, calendar
or Slack connectors yet.

## Tests

```bash
npm test
```

The browser-agent tests run against real Chromium (`VECTOR_CHROMIUM_PATH`) and skip when none is found.
