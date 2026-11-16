import { useEffect, useRef, useState } from 'react';
import { appendSpoken, speechMode, startSpeech, type SpeechMode, type SpeechSession } from '../lib/speech.ts';
import { silence } from '../lib/voiceOut.ts';
import { toast } from '../store.ts';
import { Icon } from './ui.tsx';

export type VoiceState = 'idle' | 'listening' | 'waiting';

export interface Voice {
  /** Null when this device has no way to listen: render no button. */
  mode: SpeechMode | null;
  state: VoiceState;
  /** Sound is coming in (web only). */
  hearing: boolean;
  toggle(): void;
  stop(): void;
}

/**
 * Dictation into a text field. What is heard is appended to what was already typed and left there for the
 * user to read and send: a mis-heard instruction to an agent that acts is worse than one extra tap.
 */
export function useVoice(opts: { value: string; setValue: (next: string) => void; focus?: () => void }): Voice {
  const mode = speechMode(); // cheap; re-read each render in case the app's bridge arrives after first paint
  const [state, setVoiceState] = useState<VoiceState>('idle');
  const [hearing, setHearing] = useState(false);
  const session = useRef<SpeechSession | null>(null);
  const alive = useRef(true);
  const latest = useRef(opts);
  latest.current = opts;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      session.current?.stop();
      session.current = null;
    };
  }, []);

  const start = () => {
    silence(); // tapping the mic always cuts Vector off
    const base = latest.current.value;
    const set = (spoken: string) => alive.current && latest.current.setValue(appendSpoken(base, spoken));
    let finished = false;
    let mine: SpeechSession | null = null;
    setHearing(false);
    const next = startSpeech({
      onInterim: set,
      onFinal: set,
      onHearing: () => alive.current && setHearing(true),
      onError: (message) => {
        if (!alive.current) return;
        latest.current.setValue(base);
        if (message) toast(message, 'error');
      },
      onEnd: () => {
        finished = true;
        if (session.current === mine) session.current = null;
        if (!alive.current) return;
        setVoiceState('idle');
        setHearing(false);
        latest.current.focus?.(); // the words are in the field: read them, then send
      },
    });
    if (!next) {
      toast('Voice input is not available here', 'error');
      return;
    }
    mine = next;
    if (finished) return; // the provider failed at start and has already ended
    session.current = next;
    setVoiceState(next.mode === 'native' ? 'waiting' : 'listening');
  };

  // Web: finish and keep what was heard. Native: stop waiting for the system dialog and drop its answer.
  const stop = () => session.current?.stop();

  return {
    mode,
    state,
    hearing,
    toggle: () => (session.current ? stop() : start()),
    stop,
  };
}

const VOICE_LABEL: Record<VoiceState, string> = {
  idle: 'Speak instead of typing',
  listening: 'Stop listening',
  waiting: 'Waiting for speech. Tap to stop waiting',
};

/** The mic in a composer pill. Listening: a lime button with live level bars. Waiting (native dialog): neutral. */
export function MicButton({ voice, disabled, onLongPress }: { voice: Voice; disabled?: boolean; onLongPress?: () => void }) {
  const timer = useRef<number | null>(null);
  const pressed = useRef(false);
  if (!voice.mode) return null;
  const on = voice.state !== 'idle';
  const clear = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  return (
    <button
      onPointerDown={() => {
        pressed.current = false;
        if (!onLongPress || on) return;
        clear();
        timer.current = window.setTimeout(() => {
          pressed.current = true; // the click that follows the long press is not a tap
          onLongPress();
        }, 550);
      }}
      onPointerUp={clear}
      onPointerLeave={clear}
      onPointerCancel={clear}
      onContextMenu={(e) => onLongPress && e.preventDefault()}
      type="button"
      className={`composer-btn composer-mic is-${voice.state}${voice.hearing ? ' is-hearing' : ''}`}
      aria-label={VOICE_LABEL[voice.state]}
      aria-pressed={on}
      disabled={disabled && !on}
      onClick={() => {
        if (pressed.current) {
          pressed.current = false;
          return;
        }
        voice.toggle();
      }}
    >
      {voice.state === 'listening' ? (
        <span className="mic-bars" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
          <i />
        </span>
      ) : (
        <Icon name="mic" size={20} />
      )}
    </button>
  );
}

/** Screen-reader announcement of the voice state, for the composer's live region. */
export function voiceStatus(state: VoiceState): string {
  return state === 'listening' ? 'Listening. Speak now; tap the button again to stop.' : state === 'waiting' ? 'Waiting for speech.' : '';
}
