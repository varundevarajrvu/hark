import { useEffect, useMemo, useRef, useState } from 'react';
import type { Id } from '../../../shared/types.ts';
import { cancelRun, sendMessage } from '../actions.ts';
import { SPEECH_TEXT, speechMode, startSpeech, type SpeechSession } from '../lib/speech.ts';
import { endTalk, silence, useVoiceOut } from '../lib/voiceOut.ts';
import { pendingApprovals, toast, useStore } from '../store.ts';
import { Icon, useBackToClose } from './ui.tsx';

/**
 * Hands-free conversation: listen → show what was heard → send after a visible countdown → Vector works →
 * the reply is spoken → listen again. The countdown is the one place anything is sent without a tap, and it
 * can always be cancelled or edited. Nothing is heard while Vector works or while an approval is waiting:
 * approvals are decided on screen, never by voice.
 */

export type TalkPhase = 'listening' | 'heard' | 'editing' | 'working' | 'speaking' | 'paused';

const WORD: Record<TalkPhase, string> = {
  listening: 'Listening',
  heard: 'Heard',
  editing: 'Heard',
  working: 'Working',
  speaking: 'Speaking',
  paused: 'Your call',
};

export const COUNTDOWN_MS = 2000;

export function TalkSurface({ threadId }: { threadId: Id }) {
  const running = useStore((s) => Boolean(s.running[threadId]));
  const approvals = useStore((s) => s.approvals);
  const waiting = useMemo(() => pendingApprovals(approvals).some((a) => a.threadId === threadId), [approvals, threadId]);
  const speaking = useVoiceOut((v) => v.speaking);
  const native = speechMode() === 'native';

  const [phase, setPhase] = useState<TalkPhase>('listening');
  const [text, setText] = useState('');
  const [hint, setHint] = useState('');
  const active = useRef<object | null>(null);
  const session = useRef<SpeechSession | null>(null);
  const misses = useRef(0);
  const alive = useRef(true);
  const waitingRef = useRef(waiting);
  waitingRef.current = waiting;
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const editRef = useRef<HTMLTextAreaElement>(null);

  useBackToClose(() => endTalk()); // Android Back ends the conversation before it leaves the screen

  /** Stop listening without acting on whatever the recogniser still delivers. */
  const quiet = () => {
    active.current = null;
    const s = session.current;
    session.current = null;
    s?.stop();
  };

  const finish = (message?: string) => {
    quiet();
    if (message) toast(message, 'error');
    endTalk();
  };

  const miss = () => {
    misses.current += 1;
    if (misses.current >= 2) return finish(SPEECH_TEXT.noMatch); // twice in a row: stop asking
    setHint('Did not catch that. Say it again.');
    listen();
  };

  const heard = (words: string) => {
    misses.current = 0;
    if (waitingRef.current) {
      setPhase('paused'); // never send "yes" while a slip is waiting
      return;
    }
    setText(words);
    setPhase('heard');
  };

  function listen() {
    if (!alive.current) return;
    quiet();
    if (waitingRef.current) {
      setPhase('paused');
      return;
    }
    silence();
    setText('');
    setPhase('listening');
    const token = {};
    active.current = token;
    let words = '';
    let failed = false;
    const mine = () => active.current === token && alive.current;
    const next = startSpeech({
      onInterim: (t) => {
        if (!mine()) return;
        words = t;
        setText(t);
        setHint('');
      },
      onFinal: (t) => {
        words = t;
      },
      onError: (message) => {
        if (!mine()) return;
        failed = true;
        active.current = null;
        if (message === SPEECH_TEXT.noMatch) miss();
        else finish(message ?? undefined); // cancelled (the system dialog, or us): end quietly; anything else: say why
      },
      onEnd: () => {
        if (!mine() || failed) return;
        active.current = null;
        session.current = null;
        if (words.trim()) heard(words.trim());
        else miss();
      },
    });
    if (!next) return finish(SPEECH_TEXT.unavailable);
    if (active.current === token) session.current = next;
  }

  const send = async (value: string) => {
    const words = value.trim();
    if (!words) return listen();
    if (waitingRef.current) return setPhase('paused');
    setPhase('working');
    setHint('');
    const failure = await sendMessage(threadId, words);
    if (failure && alive.current) {
      toast(failure, 'error');
      listen();
    }
  };

  // Start listening once; tidy up on the way out (navigation, End, Back).
  useEffect(() => {
    alive.current = true;
    listen();
    const hidden = () => document.visibilityState === 'hidden' && finish();
    document.addEventListener('visibilitychange', hidden);
    return () => {
      alive.current = false;
      document.removeEventListener('visibilitychange', hidden);
      quiet();
      silence();
      endTalk();
    };
  }, []);

  // Heard: send after a short visible countdown, unless cancelled or edited.
  useEffect(() => {
    if (phase !== 'heard') return;
    const timer = window.setTimeout(() => void send(text), COUNTDOWN_MS);
    return () => window.clearTimeout(timer);
  }, [phase, text]);

  // An approval pauses everything; deciding it on screen resumes.
  useEffect(() => {
    if (waiting) {
      if (phaseRef.current !== 'paused') {
        quiet();
        setPhase('paused');
      }
    } else if (phaseRef.current === 'paused') {
      if (running) setPhase('working');
      else listen();
    }
  }, [waiting]);

  // Working → speaking → listening again.
  useEffect(() => {
    if (phase === 'working' && speaking && speaking.threadId === threadId && (speaking.messageId || !running)) setPhase('speaking');
    if (phase === 'speaking' && !speaking) {
      if (running) setPhase('working');
      else listen();
    }
  }, [phase, speaking, running]);

  // A run that ends with nothing to say (stopped, failed silently): listen again once it is clearly over.
  useEffect(() => {
    if (phase !== 'working' || running) return;
    const timer = window.setTimeout(() => {
      if (phaseRef.current === 'working' && !waitingRef.current) listen();
    }, 700);
    return () => window.clearTimeout(timer);
  }, [phase, running]);

  useEffect(() => {
    if (phase === 'editing') editRef.current?.focus();
  }, [phase]);

  const line =
    phase === 'speaking'
      ? (speaking?.text ?? '')
      : phase === 'working'
        ? text
        : phase === 'paused'
          ? 'This needs your approval on screen. Decide there, and I will listen again.'
          : text;
  const placeholder = phase === 'listening' ? (native ? 'Speak when the dialog opens.' : hint || 'Say what Vector should do.') : '';

  return (
    <section className={`talk on-ink talk-${phase}${native ? ' is-native' : ''}`} aria-label="Hands-free conversation with Vector">
      <div className="talk-top">
        <span className="talk-signal" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
          <i />
          <i />
          <i />
        </span>
        <span className="label talk-kicker">Hands-free · replies aloud</span>
      </div>
      <h2 className="talk-word" aria-live="polite">
        {WORD[phase]}
        {phase === 'listening' && native ? <span className="talk-dots" aria-hidden="true" /> : null}
      </h2>

      {phase === 'editing' ? (
        <textarea
          ref={editRef}
          className="talk-edit"
          rows={2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label="What Vector heard. Edit it, then send"
          maxLength={4000}
        />
      ) : phase === 'heard' ? (
        <button type="button" className="talk-line talk-line-tap" onClick={() => setPhase('editing')} aria-label={`Heard: ${text}. Tap to edit`}>
          “{text}”
        </button>
      ) : (
        <p className={`talk-line${line ? '' : ' is-placeholder'}`} aria-live={phase === 'speaking' ? 'off' : 'polite'}>
          {line || placeholder}
        </p>
      )}

      {phase === 'heard' ? (
        <div className="talk-count" role="timer" aria-label="Sending in 2 seconds">
          <span className="talk-count-bar" />
          <span className="label">Sending · tap the words to edit</span>
        </div>
      ) : null}

      <div className="talk-actions">
        {phase === 'heard' ? (
          <button type="button" className="talk-btn talk-cancel" onClick={() => listen()}>
            Cancel
          </button>
        ) : phase === 'editing' ? (
          <>
            <button type="button" className="talk-btn talk-cancel" onClick={() => listen()}>
              Cancel
            </button>
            <button type="button" className="talk-btn talk-send" disabled={!text.trim()} onClick={() => void send(text)}>
              Send
            </button>
          </>
        ) : phase === 'working' && running ? (
          <button type="button" className="talk-btn talk-stop" onClick={() => void cancelRun(threadId)}>
            <span className="stop-glyph" aria-hidden="true" />
            Stop
          </button>
        ) : phase === 'speaking' ? (
          <button type="button" className="talk-btn talk-stop" onClick={() => silence()}>
            <Icon name="speakerOff" size={18} />
            Quiet
          </button>
        ) : null}
        <button type="button" className="talk-btn talk-end" onClick={() => finish()}>
          End
        </button>
      </div>
    </section>
  );
}
