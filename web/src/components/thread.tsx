import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ChatMessage, Id, MessagePart } from '../../../shared/types.ts';
import { cancelRun, loadOlder, loadThread, sendMessage, setOpenThread } from '../actions.ts';
import { dayKey, formatDay, formatTime } from '../lib/format.ts';
import { renderMarkdown } from '../lib/markdown.ts';
import { emptyThread, useStore } from '../store.ts';
import { ApprovalPart, HandoffPart, ToolChip } from './cards.tsx';
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
  autoFocus?: boolean;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  const submit = async () => {
    const value = text.trim();
    if (!value || sending) return;
    if (props.running) {
      setError('Vector is still working on the previous request. Wait for it to finish, or stop it.');
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
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <ErrorNote>{error}</ErrorNote>
      <div className="composer-box">
        <textarea
          ref={ref}
          rows={1}
          value={text}
          autoFocus={props.autoFocus}
          aria-label={props.label ?? 'Message Vector'}
          placeholder={props.placeholder ?? 'Ask Vector to do something…'}
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
          <button type="button" className="btn btn-stop" onClick={props.onStop}>
            <span className="stop-glyph" aria-hidden="true" />
            Stop
          </button>
        ) : (
          <button type="submit" className="btn btn-primary btn-send" disabled={!text.trim() || sending} aria-label="Send">
            {sending ? <Spinner /> : <Icon name="send" />}
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

function Part({ part, role }: { part: MessagePart; role: ChatMessage['role'] }) {
  switch (part.type) {
    case 'text':
      if (!part.text) return null;
      return role === 'assistant' ? <Markdown text={part.text} /> : <p className="user-text">{part.text}</p>;
    case 'tool':
      return <ToolChip label={part.label} name={part.name} status={part.status} summary={part.summary} />;
    case 'approval':
      return <ApprovalPart approvalId={part.approvalId} />;
    case 'handoff':
      return <HandoffPart runId={part.runId} />;
    case 'notice':
      return (
        <p className={`notice notice-${part.tone}`} role={part.tone === 'error' ? 'alert' : undefined}>
          <Icon name={part.tone === 'error' ? 'alert' : 'info'} size={16} />
          <span>{part.text}</span>
        </p>
      );
    default:
      return null;
  }
}

const SOURCE_LABEL: Record<string, string> = {
  action: 'From an Action Button',
  task: 'From a scheduled task',
  panel: 'From a panel',
};

const Message = memo(function Message(props: { message: ChatMessage; streaming: boolean; timezone?: string }) {
  const { message, streaming } = props;
  const time = formatTime(message.createdAt, props.timezone);
  if (message.role === 'user') {
    const source = message.source && message.source !== 'user' ? SOURCE_LABEL[message.source] : null;
    return (
      <article className="msg msg-user" aria-label={`You, ${time}`}>
        {source ? <span className="msg-source">{source}</span> : null}
        <div className="bubble">
          {message.parts.map((part) => (
            <Part key={part.id} part={part} role="user" />
          ))}
        </div>
      </article>
    );
  }
  const last = message.parts[message.parts.length - 1];
  const thinking = streaming && (!last || (last.type === 'tool' && last.status !== 'running'));
  return (
    <article className={`msg msg-assistant${streaming ? ' is-streaming' : ''}`} aria-label={`Vector, ${time}`}>
      <span className="msg-avatar" aria-hidden="true">
        <Mark size={16} />
      </span>
      <div className="msg-parts">
        {message.parts.map((part) => (
          <Part key={part.id} part={part} role="assistant" />
        ))}
        {thinking ? (
          <p className="thinking">
            <span className="dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <span>Thinking</span>
          </p>
        ) : null}
      </div>
    </article>
  );
});

// ───────────────────────── Thread view ─────────────────────────

export function ThreadView(props: {
  threadId: Id;
  title: string;
  subtitle?: string;
  headerActions?: ReactNode;
  emptyTitle?: string;
  emptyBody?: string;
}) {
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
      <header className="thread-head">
        <div className="thread-head-text">
          <h1>{props.title}</h1>
          {props.subtitle ? <p>{props.subtitle}</p> : null}
        </div>
        {props.headerActions}
      </header>

      <div className="thread-scroll" ref={scroller} onScroll={onScroll} tabIndex={0} aria-label="Conversation">
        <div className="thread-content" ref={content} role="log" aria-live="polite" aria-relevant="additions" aria-busy={running}>
          {thread.hasMore ? (
            <div className="thread-older">
              <button type="button" className="btn btn-sm btn-quiet" onClick={older} disabled={thread.loadingOlder}>
                {thread.loadingOlder ? <Spinner /> : null}
                {thread.loadingOlder ? 'Loading earlier messages…' : 'Show earlier messages'}
              </button>
            </div>
          ) : thread.loaded && thread.messages.length > 0 ? (
            <p className="thread-start">This is the start of the conversation.</p>
          ) : null}

          {!thread.loaded && thread.loading ? <Loading label="Loading conversation" /> : null}
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
                <Mark size={28} />
              </span>
              <h2>{props.emptyTitle ?? 'Tell Vector what you need.'}</h2>
              <p>{props.emptyBody ?? 'It remembers, plans and acts — and asks before it spends, sends or signs in. Try one:'}</p>
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
                {divider ? (
                  <p className="day-divider">
                    <span>{divider}</span>
                  </p>
                ) : null}
                <Message message={message} streaming={Boolean(streaming[message.id])} timezone={timezone} />
              </div>
            );
          })}

          {thread.pending.map((p) => (
            <div key={p.localId} className="msg-row">
              <article className="msg msg-user is-pending" aria-label="You, sending">
                <div className="bubble">
                  <p className="user-text">{p.text}</p>
                </div>
              </article>
            </div>
          ))}

          {thread.lastRun ? (
            <p className={`notice ${thread.lastRun.status === 'error' ? 'notice-error' : 'notice-info'} run-end`}>
              <Icon name={thread.lastRun.status === 'error' ? 'alert' : 'info'} size={16} />
              <span>
                {thread.lastRun.status === 'cancelled'
                  ? 'Stopped. Nothing further was done.'
                  : `That run failed. ${thread.lastRun.error ?? 'Try again in a moment.'}`}
              </span>
            </p>
          ) : null}
        </div>
      </div>

      <div className="thread-foot">
        {running ? (
          <p className="run-status">
            <span className="pulse" aria-hidden="true" />
            Vector is working. You can stop it at any time.
          </p>
        ) : null}
        <Composer onSend={send} running={running} onStop={() => void cancelRun(threadId)} placeholder="Message Vector…" />
      </div>
    </div>
  );
}
