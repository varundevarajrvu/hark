/**
 * Voice input behind one small interface. Providers, in the order they are tried:
 *  1. the Android app's native bridge (`window.VectorNative`): the system speech dialog, one result, no stop;
 *  2. the Web Speech API (`SpeechRecognition` / `webkitSpeechRecognition`): interim words, tap again to stop;
 *  3. neither: `speechMode()` returns null and no button is rendered.
 * Nothing here ever sends a message: recognised text is handed back for the user to review.
 */

export type SpeechMode = 'native' | 'web';

export interface SpeechHandlers {
  /** Words recognised so far (web only). Replaces the previous interim text. */
  onInterim(text: string): void;
  /** The final transcript. May be empty. Always followed by onEnd. */
  onFinal(text: string): void;
  /** Speech was heard (web only): lets the UI show that sound is coming in. */
  onHearing?(): void;
  /** A short sentence for a toast, or null for a silent end (cancelled by the user). Always followed by onEnd. */
  onError(message: string | null): void;
  /** The session is over, one way or another. Called exactly once. */
  onEnd(): void;
}

export interface SpeechSession {
  mode: SpeechMode;
  /** Finish listening and keep what was heard (web). On the native path this stops waiting and drops the result. */
  stop(): void;
}

export const SPEECH_TEXT = {
  noMatch: 'Did not catch that',
  blocked: 'Microphone is blocked for this site',
  unavailable: 'Voice input is not available here',
  busy: 'Voice input is busy. Try again',
  noMic: 'No microphone found',
  network: 'The speech service could not be reached',
} as const;

// ───────────────────────── Native bridge (Android app) ─────────────────────────

interface NativeBridge {
  postMessage(message: string): void;
  onmessage: ((event: { data: unknown } | string) => void) | null;
}

type NativeReply = { type: 'speech.result'; id: string; text: string } | { type: 'speech.error'; id: string; error: string };

function nativeBridge(): NativeBridge | null {
  const bridge = (window as unknown as { VectorNative?: unknown }).VectorNative as Partial<NativeBridge> | undefined;
  return bridge && typeof bridge.postMessage === 'function' ? (bridge as NativeBridge) : null;
}

const nativeWaiting = new Map<string, (reply: NativeReply) => void>();
let nativeHooked: NativeBridge | null = null;

/** One dispatcher on the bridge for the page's lifetime; anything that is not ours goes to whoever was there before. */
function hookNative(bridge: NativeBridge): void {
  if (nativeHooked === bridge) return;
  nativeHooked = bridge;
  const previous = typeof bridge.onmessage === 'function' ? bridge.onmessage : null;
  bridge.onmessage = (event) => {
    const raw = typeof event === 'string' ? event : event?.data;
    let reply: Partial<NativeReply> | null = null;
    try {
      reply = typeof raw === 'string' ? (JSON.parse(raw) as Partial<NativeReply>) : null;
    } catch {
      reply = null;
    }
    const waiter = reply && typeof reply.id === 'string' ? nativeWaiting.get(reply.id) : undefined;
    if (reply && waiter && (reply.type === 'speech.result' || reply.type === 'speech.error')) {
      nativeWaiting.delete(reply.id as string);
      waiter(reply as NativeReply);
      return;
    }
    previous?.call(bridge, event); // not a reply to an id we sent
  };
}

let idSeq = 0;
function uniqueId(): string {
  idSeq += 1;
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2);
  return `speech-${idSeq}-${random}`;
}

const NATIVE_ERRORS: Record<string, string | null> = {
  cancelled: null,
  no_match: SPEECH_TEXT.noMatch,
  unavailable: SPEECH_TEXT.unavailable,
  busy: SPEECH_TEXT.busy,
};

function startNative(bridge: NativeBridge, handlers: SpeechHandlers): SpeechSession {
  hookNative(bridge);
  const id = uniqueId();
  let over = false;
  const end = () => {
    if (over) return;
    over = true;
    nativeWaiting.delete(id);
    handlers.onEnd();
  };
  nativeWaiting.set(id, (reply) => {
    if (over) return;
    if (reply.type === 'speech.result') handlers.onFinal(typeof reply.text === 'string' ? reply.text : '');
    else handlers.onError(reply.error in NATIVE_ERRORS ? (NATIVE_ERRORS[reply.error] ?? null) : SPEECH_TEXT.unavailable);
    end();
  });
  try {
    bridge.postMessage(JSON.stringify({ type: 'speech.start', id }));
  } catch {
    handlers.onError(SPEECH_TEXT.unavailable);
    end();
  }
  return { mode: 'native', stop: end };
}

// ───────────────────────── Web Speech API ─────────────────────────

interface RecognitionResult {
  isFinal: boolean;
  0?: { transcript: string };
}
interface RecognitionEvent {
  resultIndex: number;
  results: ArrayLike<RecognitionResult>;
}
interface Recognition {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  onspeechstart: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognitionCtor = new () => Recognition;

function recognitionCtor(): RecognitionCtor | null {
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  const ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
  // The service refuses plain-http pages (a phone on http://<lan-ip>), so do not offer a button that cannot work.
  return ctor && window.isSecureContext ? ctor : null;
}

const WEB_ERRORS: Record<string, string | null> = {
  'not-allowed': SPEECH_TEXT.blocked,
  'service-not-allowed': SPEECH_TEXT.blocked,
  'no-speech': SPEECH_TEXT.noMatch,
  'audio-capture': SPEECH_TEXT.noMic,
  network: SPEECH_TEXT.network,
  aborted: null,
  'language-not-supported': SPEECH_TEXT.unavailable,
};

function startWeb(Ctor: RecognitionCtor, handlers: SpeechHandlers): SpeechSession {
  let over = false;
  let failed = false;
  let finalText = '';
  let interimText = '';
  const end = () => {
    if (over) return;
    over = true;
    if (!failed) handlers.onFinal((finalText || interimText).trim());
    handlers.onEnd();
  };
  const fail = (message: string | null) => {
    if (over || failed) return;
    failed = true;
    handlers.onError(message);
  };

  let rec: Recognition;
  try {
    rec = new Ctor();
    rec.lang = navigator.language || 'en-US';
    rec.interimResults = true;
    rec.continuous = false;
    rec.maxAlternatives = 1;
  } catch {
    fail(SPEECH_TEXT.unavailable);
    end();
    return { mode: 'web', stop: () => {} };
  }

  rec.onresult = (event) => {
    let done = '';
    let heard = '';
    for (let i = 0; i < event.results.length; i++) {
      const result = event.results[i];
      const words = result?.[0]?.transcript ?? '';
      if (result?.isFinal) done += words;
      heard += words;
    }
    finalText = done;
    interimText = heard;
    handlers.onInterim(heard.trim());
  };
  rec.onspeechstart = () => handlers.onHearing?.();
  rec.onerror = (event) => fail(event.error in WEB_ERRORS ? (WEB_ERRORS[event.error] ?? null) : SPEECH_TEXT.unavailable);
  rec.onend = end;

  try {
    rec.start();
  } catch {
    fail(SPEECH_TEXT.unavailable);
    end();
  }

  return {
    mode: 'web',
    stop: () => {
      if (over) return;
      try {
        rec.stop(); // delivers what was heard, then onend
      } catch {
        end();
      }
    },
  };
}

// ───────────────────────── Public ─────────────────────────

/** Which provider a mic button would use right now, or null when there is none (render no button). */
export function speechMode(): SpeechMode | null {
  if (typeof window === 'undefined') return null;
  if (nativeBridge()) return 'native';
  if (recognitionCtor()) return 'web';
  return null;
}

export function startSpeech(handlers: SpeechHandlers): SpeechSession | null {
  const bridge = nativeBridge();
  if (bridge) return startNative(bridge, handlers);
  const Ctor = recognitionCtor();
  if (Ctor) return startWeb(Ctor, handlers);
  return null;
}

/** Recognised words go after whatever was already typed, separated by one space. */
export function appendSpoken(base: string, spoken: string): string {
  const words = spoken.trim();
  if (!words) return base;
  const head = base.replace(/\s+$/, '');
  return head ? `${head} ${words}` : words;
}
