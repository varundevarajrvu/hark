import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ChatMessage, Id, MessagePart } from '../../../shared/types.ts';
import { cancelRun, loadOlder, loadThread, sendMessage, setOpenThread } from '../actions.ts';
import { dayKey, formatDay, formatTime } from '../lib/format.ts';
import { renderMarkdown } from '../lib/markdown.ts';
import { emptyThread, useStore } from '../store.ts';
import { ApprovalPart, ConsentBar, HandoffPart, TraceStack } from './cards.tsx';
import { ErrorNote, Icon, Loading, Mark, PromptChip, Spinner } from './ui.tsx';

export const STARTER_PROMPTS = [
  "Remember that I'm vegetarian",
  'Build me a panel that tracks my reading streak',
  'Every weekday at 8, give me a briefing',
  'Find the cheapest direct flight BLR → DEL next Friday',
];

// ───────────────────────── Composer ─────────────────────────

export function Composer(props: {
  onSend: (text: string) => Promise<string | null>;
  running?: boolean;
  onStop?: () => void;
  placeholder?: string;
  label?: string;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`;
  }, [text]);

  const submit = async () => {
    const value = text.trim();
    if (!value || sending) return;
    if (props.running) {
      setError('Still working on the last request. Wait, or stop it.');
      return;
    }
    setSending(true);
    setError('');
    setText('');
    const failure = await props.onSend(value);
    setSending(false);
    if (failure) {
      setError(failure);
      setText((current) => current || value); // give the words back
    }
  };

  return (
    <form
      className={`composer${props.running ? ' is-running' : ''}`}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <ErrorNote>{error}</ErrorNote>
      <div className="composer-pill">
        {props.running ? (
          <span className="composer-live" role="status">
            <span className="pulse" aria-hidden="true" />
            <span className="sr-only">Vector is working. You can stop it at any time.</span>
          </span>
        ) : null}
        <textarea
          ref={ref}
          rows={1}
          value={text}
          aria-label={props.label ?? 'Message Vector'}
          placeholder={props.running ? 'Working…' : (props.placeholder ?? 'Tell Vector what to do')}
          enterKeyHint="send"
          onChange={(e) => {
            setText(e.target.value);
            if (error) setError('');
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        {props.running && props.onStop ? (
          <button type="button" className="composer-btn composer-stop" onClick={props.onStop}>
            <span className="stop-glyph" aria-hidden="true" />
            Stop
          </button>
        ) : (
          <button type="submit" className="composer-btn composer-send" disabled={!text.trim() || sending} aria-label="Send">
            {sending ? <Spinner /> : <Icon name="send" size={20} />}
          </button>
        )}
      </div>
    </form>
  );
}

// ───────────────────────── Messages ─────────────────────────

const Markdown = memo(function Markdown({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  // Sanitised by DOMPurify in renderMarkdown: the only place HTML is inserted in the app.
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
});

type ToolPart = Extract<MessagePart, { type: 'tool' }>;
type Block = { kind: 'part'; part: MessagePart } | { kind: 'trace'; id: Id; tools: ToolPart[] };

/** Consecutive tool parts collapse into one trace stack. */
function blocksOf(parts: MessagePart[]): Block[] {
  const blocks: Block[] = [];
  for (const part of parts) {
    const last = blocks[blocks.length - 1];
    if (part.type === 'tool') {
      if (last?.kind === 'trace') last.tools.push(part);
      else blocks.push({ kind: 'trace', id: part.id, tools: [part] });
    } else blocks.push({ kind: 'part', part });
  }
  return blocks;
}

function AssistantPart({ part }: { part: MessagePart }) {
  switch (part.type) {
    case 'text':
      return part.text ? <Markdown text={part.text} /> : null;
    case 'approval':
      return <ApprovalPart approvalId={part.approvalId} />;
    case 'handoff':
      return <HandoffPart runId={part.runId} />;
    case 'notice':
      return (
        <p className={`notice notice-${part.tone}`} role={part.tone === 'error' ? 'alert' : undefined}>
          <span className="label">{part.tone === 'error' ? 'Error' : 'Note'}</span>
          <span>{part.text}</span>
        </p>
      );
    default:
      return null;
  }
}

const SOURCE_LABEL: Record<string, string> = {
  action: 'Action button',
  task: 'Scheduled task',
  panel: 'Panel',
};

const Message = memo(function Message(props: { message: ChatMessage; streaming: boolean; timezone?: string }) {
  const { message, streaming } = props;
  const time = formatTime(message.createdAt, props.timezone);
  const blocks = useMemo(() => blocksOf(message.parts), [message.parts]);
  if (message.role === 'user') {
    const source = message.source && message.source !== 'user' ? SOURCE_LABEL[message.source] : null;
    return (
      <article className="msg msg-user" aria-label={`You, ${time}`}>
        <div className="bubble">
          {message.parts.map((part) => (part.type === 'text' ? <p key={part.id}>{part.text}</p> : null))}
        </div>
        <span className="label msg-meta">
          {source ? `${source} · ` : ''}
          {time}
        </span>
      </article>
    );
  }
  const last = message.parts[message.parts.length - 1];
  const thinking = streaming && (!last || (last.type === 'tool' && last.status !== 'running'));
  return (
    <article className={`msg msg-vector${streaming ? ' is-streaming' : ''}`} aria-label={`Vector, ${time}`}>
      <span className="label msg-meta">
        <Mark size={11} />
        Vector · {time}
      </span>
      {blocks.map((block) =>
        block.kind === 'trace' ? <TraceStack key={block.id} tools={block.tools} /> : <AssistantPart key={block.part.id} part={block.part} />,
      )}
      {thinking ? (
        <p className="thinking label">
          <span className="caret" aria-hidden="true" />
          Thinking
        </p>
      ) : null}
    </article>
  );
});

// ───────────────────────── Thread view ─────────────────────────

export function ThreadView(props: { threadId: Id; strip?: ReactNode; emptyTitle?: string; emptyBody?: string }) {
  const { threadId } = props;
  const thread = useStore((s) => s.threads[threadId]) ?? emptyThread;
  const running = useStore((s) => Boolean(s.running[threadId]));
  const streaming = useStore((s) => s.streaming);
  const timezone = useStore((s) => s.user?.settings.timezone);
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const anchor = useRef<{ height: number; top: number; firstId: Id | undefined } | null>(null);

  useEffect(() => {
    setOpenThread(threadId);
    stick.current = true;
    void loadThread(threadId);
    return () => setOpenThread(null);
  }, [threadId]);

  // Keep the newest content in view while the user is at the bottom (text streams, cards grow, images load).
  useEffect(() => {
    const el = scroller.current;
    const inner = content.current;
    if (!el || !inner) return;
    const observer = new ResizeObserver(() => {
      if (stick.current && !anchor.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(inner);
    return () => observer.disconnect();
  }, []);

  const firstId = thread.messages[0]?.id;
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const held = anchor.current;
    if (held && held.firstId !== firstId) {
      // Older messages were added above: stay on the message the user was reading.
      el.scrollTop = held.top + (el.scrollHeight - held.height);
      anchor.current = null;
    } else if (stick.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [firstId, thread.messages, thread.pending, threadId]);

  const older = () => {
    const el = scroller.current;
    if (!el || !thread.hasMore || thread.loadingOlder) return;
    anchor.current = { height: el.scrollHeight, top: el.scrollTop, firstId };
    void loadOlder(threadId).finally(() => {
      window.setTimeout(() => (anchor.current = null), 0);
    });
  };

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
    if (el.scrollTop < 160 && thread.loaded) older();
  };

  const send = (text: string) => {
    stick.current = true;
    return sendMessage(threadId, text);
  };

  const isEmpty = thread.loaded && thread.messages.length === 0 && thread.pending.length === 0;
  let lastDay = '';

  return (
    <div className="thread">
      {props.strip ? <div className="thread-strip">{props.strip}</div> : null}

      <div className="thread-scroll" ref={scroller} onScroll={onScroll} tabIndex={0} aria-label="Conversation">
        <div className="thread-content" ref={content} role="log" aria-live="polite" aria-relevant="additions" aria-busy={running}>
          {thread.hasMore ? (
            <div className="thread-older">
              <button type="button" className="btn btn-sm btn-quiet label" onClick={older} disabled={thread.loadingOlder}>
                {thread.loadingOlder ? <Spinner /> : null}
                {thread.loadingOlder ? 'Loading earlier' : 'Earlier messages'}
              </button>
            </div>
          ) : thread.loaded && thread.messages.length > 0 ? (
            <p className="label thread-start">Start of thread</p>
          ) : null}

          {!thread.loaded && thread.loading ? <Loading label="Loading thread" /> : null}
          {thread.error ? (
            <div className="thread-error">
              <ErrorNote>{thread.error}</ErrorNote>
              <button type="button" className="btn btn-sm" onClick={() => void loadThread(threadId, true)}>
                Try again
              </button>
            </div>
          ) : null}

          {isEmpty ? (
            <div className="thread-empty">
              <span className="thread-empty-mark">
                <Mark size={44} />
              </span>
              <h2>{props.emptyTitle ?? 'Say it once.'}</h2>
              <p>{props.emptyBody ?? 'Vector remembers, plans and acts. It asks before it spends, sends or signs in.'}</p>
              <div className="prompt-grid">
                {STARTER_PROMPTS.map((prompt) => (
                  <PromptChip key={prompt} text={prompt} onPick={(text) => void send(text)} disabled={running} />
                ))}
              </div>
            </div>
          ) : null}

          {thread.messages.map((message) => {
            const day = dayKey(message.createdAt, timezone);
            const divider = day !== lastDay ? formatDay(message.createdAt, timezone) : null;
            lastDay = day;
            return (
              <div key={message.id} className="msg-row">
                {divider ? <p className="label day-divider">{divider}</p> : null}
                <Message message={message} streaming={Boolean(streaming[message.id])} timezone={timezone} />
              </div>
            );
          })}

          {thread.pending.map((p) => (
            <div key={p.localId} className="msg-row">
              <article className="msg msg-user is-pending" aria-label="You, sending">
                <div className="bubble">
                  <p>{p.text}</p>
                </div>
                <span className="label msg-meta">Sending</span>
              </article>
            </div>
          ))}

          {thread.lastRun ? (
            <p className={`notice ${thread.lastRun.status === 'error' ? 'notice-error' : 'notice-info'} run-end`}>
              <span className="label">{thread.lastRun.status === 'error' ? 'Run failed' : 'Stopped'}</span>
              <span>
                {thread.lastRun.status === 'cancelled' ? 'Nothing further was done.' : (thread.lastRun.error ?? 'Try again in a moment.')}
              </span>
            </p>
          ) : null}
        </div>
      </div>

      <div className="floor">
        <ConsentBar />
        <Composer onSend={send} running={running} onStop={() => void cancelRun(threadId)} />
      </div>
    </div>
  );
}
