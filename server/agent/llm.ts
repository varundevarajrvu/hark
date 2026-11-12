import Anthropic from '@anthropic-ai/sdk';
import { config, credentialsHint, hasLlmCredentials } from '../core/config.ts';

/**
 * The one seam between the product and the model. Both agents (the orchestrator in server/agent and
 * the browser agent in server/handoff) talk to the model only through `LlmClient.runTurn`, so tests
 * and the offline demo can swap in a scripted implementation with the same shapes.
 */

export type LlmBlock = Anthropic.Beta.BetaContentBlock;
export type LlmMessage = Anthropic.Beta.BetaMessageParam;
export type LlmTool = Anthropic.Beta.BetaToolUnion;

export interface LlmRequest {
  /** Stable system prompt text. The client sends it as one cached block. */
  system: string;
  /** Full, append-only conversation. Assistant content must be what a previous call returned. */
  messages: LlmMessage[];
  tools: LlmTool[];
  signal: AbortSignal;
  onTextDelta?: (text: string) => void;
  /** A tool call (client or server tool) started streaming; lets the UI show a chip early. */
  onToolStart?: (tool: { id: string; name: string; server: boolean }) => void;
}

export interface LlmResponse {
  content: LlmBlock[];
  stop_reason: Anthropic.Beta.BetaStopReason | null;
  usage: { input_tokens: number; output_tokens: number };
  model: string;
}

export interface LlmClient {
  runTurn(req: LlmRequest): Promise<LlmResponse>;
}

/** No usable credentials (none configured, or the API rejected them). */
export class LlmCredentialsError extends Error {
  constructor() {
    super(noCredentialsNotice());
  }
}

export function noCredentialsNotice(): string {
  return `No working model API key is configured on the server. ${credentialsHint()}`;
}

/** A failed call to an OpenAI-compatible provider. `detail` is for the server log only. */
export class LlmHttpError extends Error {
  constructor(readonly status: number, readonly detail: string) {
    super(`model API returned ${status}`);
  }
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Anthropic.APIUserAbortError || (err instanceof Error && err.name === 'AbortError');
}

/** A short, user-safe sentence for a failed model call. Never includes raw API messages or request ids. */
export function describeLlmError(err: unknown): string {
  if (err instanceof LlmCredentialsError || err instanceof Anthropic.AuthenticationError) return noCredentialsNotice();
  if (err instanceof LlmHttpError) {
    if (err.status === 429) return 'The model’s free quota or rate limit is used up for now. Wait a minute and try again.';
    if (err.status === 404) return `The model “${config.model}” was not found at this provider. Check VECTOR_MODEL.`;
    if (err.status === 400) return 'The model provider rejected the request. The server log has the details.';
    if (err.status >= 500) return 'The model provider is temporarily unavailable. Try again shortly.';
    return 'The model provider returned an error. The server log has the details.';
  }
  if (err instanceof TypeError && /fetch failed/i.test(err.message)) return 'Could not reach the model provider. Check the server’s network connection.';
  if (err instanceof Anthropic.PermissionDeniedError) return 'The configured Claude API key is not allowed to use this model.';
  if (err instanceof Anthropic.NotFoundError) return 'The configured Claude model was not found. Check VECTOR_MODEL.';
  if (err instanceof Anthropic.RateLimitError) return 'Claude is rate limited right now. Try again in a minute.';
  if (err instanceof Anthropic.BadRequestError) return 'Claude rejected the request. The server log has the details.';
  if (err instanceof Anthropic.APIConnectionError) return 'Could not reach the Claude API. Check the server’s network connection.';
  if (err instanceof Anthropic.InternalServerError) return 'Claude is temporarily unavailable. Try again shortly.';
  if (err instanceof Anthropic.APIError) return 'The Claude API returned an error. Try again shortly.';
  return 'Something went wrong while working on that.';
}

/**
 * What to send back as the assistant message for a response. Normally the content exactly as
 * returned (thinking blocks included; they are bound to this history). The one documented exception:
 * when a refusal fallback switched models mid-output, blocks the declining model produced before the
 * last `fallback` block must not be echoed, except text and completed server-tool pairs. The
 * `fallback` block itself stays where it was.
 */
export function echoContent(content: LlmBlock[]): LlmBlock[] {
  let boundary = -1;
  content.forEach((b, i) => {
    if (b.type === 'fallback') boundary = i;
  });
  if (boundary < 0) return content;
  const answered = new Set<string>();
  for (const b of content) {
    const id = (b as { tool_use_id?: unknown }).tool_use_id;
    if (typeof id === 'string') answered.add(id);
  }
  return content.filter((b, i) => {
    if (i >= boundary || b.type === 'fallback' || b.type === 'text') return true;
    if (b.type === 'server_tool_use') return answered.has(b.id);
    return typeof (b as { tool_use_id?: unknown }).tool_use_id === 'string'; // a server tool result
  });
}

// ───────────────────────── block builders (offline model + tests) ─────────────────────────

let fakeId = 0;
export function textBlock(text: string): LlmBlock {
  return { type: 'text', text, citations: null };
}
export function toolUseBlock(name: string, input: unknown, id?: string): LlmBlock {
  return { type: 'tool_use', id: id ?? `toolu_local_${(++fakeId).toString(36)}`, name, input };
}

// ───────────────────────── the real client ─────────────────────────

/**
 * Tool calls made through another provider carry a private `_extra` field (see openai-compat.ts).
 * Claude's API rejects unknown fields, so drop it when a thread started elsewhere is replayed here.
 * Blocks Claude produced never have it, so its own history is passed back untouched.
 */
function withoutForeignFields(messages: LlmMessage[]): LlmMessage[] {
  return messages.map((m) => {
    if (!Array.isArray(m.content) || !m.content.some((b) => '_extra' in b)) return m;
    const content = m.content.map((b) => {
      if (!('_extra' in b)) return b;
      const copy: Record<string, unknown> = { ...b };
      delete copy._extra;
      return copy;
    });
    return { ...m, content } as LlmMessage;
  });
}

const MAX_TOKENS = 64_000;
type StreamBody = Parameters<Anthropic['beta']['messages']['stream']>[0];

export function createAnthropicClient(): LlmClient {
  let client: Anthropic | null = null;

  return {
    async runTurn(req) {
      // Checked per call rather than at boot so the server starts (and says so plainly) without a key.
      if (!hasLlmCredentials()) throw new LlmCredentialsError();
      client ??= new Anthropic();

      const betas: string[] = [];
      const body: StreamBody = {
        model: config.model,
        max_tokens: MAX_TOKENS,
        // Thinking is always on for this model family: no `thinking`, no sampling parameters, tool_choice auto.
        output_config: { effort: config.effort },
        system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
        // Automatic breakpoint on the last cacheable block, so the append-only history is read from cache too.
        cache_control: { type: 'ephemeral' },
        messages: withoutForeignFields(req.messages),
        tools: req.tools,
      };
      if (config.useFallbacks) {
        betas.push('server-side-fallback-2026-07-01');
        body.fallbacks = 'default';
      }
      if (config.useCompaction) {
        betas.push('compact-2026-01-12');
        body.context_management = { edits: [{ type: 'compact_20260112' }] };
      }
      if (betas.length > 0) body.betas = betas;

      // With eager input streaming a tool input the SDK cannot parse at all rejects finalMessage()
      // with a non-API error and the turn was never completed, so it is safe to issue it again.
      for (let jsonFailures = 0; ; ) {
        const stream = client.beta.messages.stream(body, { signal: req.signal });
        if (req.onTextDelta) stream.on('text', (delta) => req.onTextDelta!(delta));
        if (req.onToolStart) {
          stream.on('streamEvent', (event) => {
            if (event.type !== 'content_block_start') return;
            const b = event.content_block;
            if (b.type === 'tool_use') req.onToolStart!({ id: b.id, name: b.name, server: false });
            else if (b.type === 'server_tool_use') req.onToolStart!({ id: b.id, name: b.name, server: true });
          });
        }
        try {
          const message = await stream.finalMessage();
          const u = message.usage;
          return {
            content: message.content,
            stop_reason: message.stop_reason,
            usage: {
              input_tokens: u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
              output_tokens: u.output_tokens,
            },
            model: message.model,
          };
        } catch (err) {
          if (err instanceof Anthropic.AuthenticationError) throw new LlmCredentialsError();
          if (err instanceof Anthropic.APIError || isAbortError(err) || req.signal.aborted || ++jsonFailures > 2) throw err;
        }
      }
    },
  };
}
