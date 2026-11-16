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

interface NativeReply {
  type: string;
  id: string;
  [key: string]: unknown;
}

function nativeBridge(): NativeBridge | null {
  const bridge = (window as unknown as { VectorNative?: unknown }).VectorNative as Partial<NativeBridge> | undefined;
  return bridge && typeof bridge.postMessage === 'function' ? (bridge as NativeBridge) : null;
}

/** Replies are matched to requests by id; a reply to an id we did not send is ignored. */
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
    const waiter = reply && typeof reply.id === 'string' && typeof reply.type === 'string' ? nativeWaiting.get(reply.id) : undefined;
    if (reply && waiter) {
      waiter(reply as NativeReply);
      return;
    }
    previous?.call(bridge, event); // not a reply to an id we sent
  };
}

function postNative(bridge: NativeBridge, message: Record<string, unknown>): boolean {
  try {
    bridge.postMessage(JSON.stringify(message));
    return true;
  } catch {
    return false;
  }
}

// ── What the app can do: asked once. An app that never answers predates the question: it can listen, not speak.

export interface NativeCaps {
  speech: boolean;
  tts: boolean;
}
let caps: NativeCaps | null = null;
let capsAsked = false;
const capsListeners = new Set<() => void>();

/** Ask the app what it supports (once). Call at startup; harmless without the app. */
export function probeNative(timeoutMs = 1000): void {
  if (capsAsked || typeof window === 'undefined') return;
  const bridge = nativeBridge();
  if (!bridge) return;
  capsAsked = true;
  hookNative(bridge);
  const id = uniqueId();
  const settle = (next: NativeCaps) => {
    if (caps) return;
    nativeWaiting.delete(id);
    caps = next;
    for (const fn of [...capsListeners]) fn();
  };
  nativeWaiting.set(id, (reply) => {
    if (reply.type !== 'capabilities') return;
    settle({ speech: reply.speech !== false, tts: reply.tts === true });
  });
  window.setTimeout(() => settle({ speech: true, tts: false }), timeoutMs);
  if (!postNative(bridge, { type: 'capabilities', id })) settle({ speech: true, tts: false });
}

/** Changes to what the device can do (the app's answer arriving, voices loading). */
export function onSpeechSupportChange(fn: () => void): () => void {
  capsListeners.add(fn);
  return () => capsListeners.delete(fn);
}
function supportChanged(): void {
  for (const fn of [...capsListeners]) fn();
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
    if (over || (reply.type !== 'speech.result' && reply.type !== 'speech.error')) return;
    if (reply.type === 'speech.result') handlers.onFinal(typeof reply.text === 'string' ? reply.text : '');
    else {
      const code = String(reply.error);
      handlers.onError(code in NATIVE_ERRORS ? (NATIVE_ERRORS[code] ?? null) : SPEECH_TEXT.unavailable);
    }
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
  if (nativeBridge()) return caps && !caps.speech ? null : 'native';
  if (recognitionCtor()) return 'web';
  return null;
}

export function startSpeech(handlers: SpeechHandlers): SpeechSession | null {
  const bridge = nativeBridge();
  if (bridge) return caps && !caps.speech ? null : startNative(bridge, handlers);
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

// ───────────────────────── Speaking (text to speech) ─────────────────────────

export type TtsMode = 'native' | 'web';

export interface Utterance {
  mode: TtsMode;
  /** Stop now. onEnd still runs, once. */
  stop(): void;
}

const NATIVE_TTS_MAX = 4000;

/**
 * Which voice output this device has: the app (when it said so), else the browser's speechSynthesis, else none.
 * Inside the app, nothing is offered until the app has answered (or failed to answer) the capabilities question.
 */
export function ttsMode(): TtsMode | null {
  if (typeof window === 'undefined') return null;
  if (nativeBridge()) {
    if (!caps) return null;
    if (caps.tts) return 'native';
  }
  return webSynth() ? 'web' : null;
}

function webSynth(): SpeechSynthesis | null {
  const synth = (window as { speechSynthesis?: SpeechSynthesis }).speechSynthesis;
  return synth && typeof synth.speak === 'function' && typeof window.SpeechSynthesisUtterance === 'function' ? synth : null;
}

let voice: SpeechSynthesisVoice | null | undefined;
let voicesHooked = false;
/** The best voice for the page's language; voices load asynchronously in Chrome, so this is re-picked when they arrive. */
function pickVoice(synth: SpeechSynthesis): SpeechSynthesisVoice | null {
  if (!voicesHooked) {
    voicesHooked = true;
    synth.addEventListener?.('voiceschanged', () => {
      voice = undefined;
      supportChanged();
    });
  }
  if (voice !== undefined) return voice;
  const voices = synth.getVoices?.() ?? [];
  if (!voices.length) return null; // not loaded yet: let the engine use its default, try again next time
  const lang = (navigator.language || 'en-US').toLowerCase();
  const base = lang.split('-')[0] ?? lang;
  const same = voices.filter((v) => v.lang.toLowerCase().replace('_', '-') === lang);
  const near = voices.filter((v) => (v.lang.toLowerCase().split(/[-_]/)[0] ?? '') === base);
  const pool = same.length ? same : near;
  voice = pool.find((v) => v.localService) ?? pool.find((v) => v.default) ?? pool[0] ?? null;
  return voice;
}

/** Sentence-sized pieces: Chrome cuts a long utterance off after about fifteen seconds. */
export function chunkForSpeech(text: string, max = 180): string[] {
  const sentences = text.match(/[^.!?…]+[.!?…]+["'”’)]*\s*|[^.!?…]+$/g) ?? [text];
  const chunks: string[] = [];
  let current = '';
  for (const raw of sentences) {
    const sentence = raw.trim();
    if (!sentence) continue;
    if (sentence.length > max) {
      if (current) chunks.push(current), (current = '');
      let rest = sentence;
      while (rest.length > max) {
        const cut = rest.lastIndexOf(' ', max);
        const at = cut > max / 2 ? cut : max;
        chunks.push(rest.slice(0, at).trim());
        rest = rest.slice(at).trim();
      }
      current = rest;
    } else if ((current + ' ' + sentence).trim().length > max) {
      chunks.push(current);
      current = sentence;
    } else current = (current + ' ' + sentence).trim();
  }
  if (current) chunks.push(current);
  return chunks;
}

let activeUtterance: Utterance | null = null;

/** Speak `text`, replacing anything already being spoken. Returns null when there is no voice output. */
export function speakText(text: string, onEnd: (error?: string) => void): Utterance | null {
  activeUtterance?.stop();
  const mode = ttsMode();
  const bridge = nativeBridge();
  let over = false;
  const end = (error?: string) => {
    if (over) return;
    over = true;
    if (activeUtterance === utterance) activeUtterance = null;
    onEnd(error);
  };
  let utterance: Utterance;
  if (mode === 'native' && bridge) {
    hookNative(bridge);
    const id = uniqueId();
    nativeWaiting.set(id, (reply) => {
      if (reply.type !== 'tts.done' && reply.type !== 'tts.error') return;
      nativeWaiting.delete(id);
      end(reply.type === 'tts.error' ? String(reply.error) : undefined);
    });
    utterance = {
      mode,
      stop: () => {
        if (over) return;
        nativeWaiting.delete(id);
        postNative(bridge, { type: 'tts.stop' });
        end();
      },
    };
    activeUtterance = utterance;
    if (!postNative(bridge, { type: 'tts.speak', id, text: text.slice(0, NATIVE_TTS_MAX) })) end('unavailable');
    return utterance;
  }
  const synth = mode === 'web' ? webSynth() : null;
  if (!synth) return null;
  const chosen = pickVoice(synth);
  const lang = navigator.language || 'en-US';
  const chunks = chunkForSpeech(text);
  utterance = {
    mode: 'web',
    stop: () => {
      if (over) return;
      end();
      synth.cancel();
    },
  };
  activeUtterance = utterance;
  synth.cancel(); // anything queued by an earlier page state
  chunks.forEach((chunk, i) => {
    const u = new SpeechSynthesisUtterance(chunk);
    u.lang = chosen?.lang ?? lang;
    if (chosen) u.voice = chosen;
    if (i === chunks.length - 1) u.onend = () => end();
    u.onerror = (e) => end(e.error === 'interrupted' || e.error === 'canceled' ? undefined : String(e.error));
    synth.speak(u);
  });
  if (!chunks.length) end();
  return utterance;
}

/** Stop whatever is being spoken, on any provider. */
export function stopSpeaking(): void {
  activeUtterance?.stop();
}
