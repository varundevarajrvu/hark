/**
 * Vector's voice: when to read a reply aloud, and the hands-free conversation flag.
 *
 * Only replies to runs this client started in this page session are spoken, only in the thread that is open,
 * and only while the page is visible: old history, scheduled runs and anything arriving behind the user's
 * back stay silent. An approval is announced, never decided, by voice.
 */
import { useSyncExternalStore } from 'react';
import type { Id, ServerEvent } from '../../../shared/types.ts';
import { getState, toast } from '../store.ts';
import { onSpeechSupportChange, probeNative, speakText, speechMode, stopSpeaking, ttsMode, ttsUndecided, type Utterance } from './speech.ts';
import { APPROVAL_LINE, RUN_FAILED_LINE, speakableReply } from './spoken.ts';

export interface VoiceOutState {
  /** The user's "read replies aloud" preference. */
  enabled: boolean;
  /** This device can speak at all. */
  canSpeak: boolean;
  /** This device can hold a hands-free conversation (listen and speak). */
  canTalk: boolean;
  /** What is being said right now; messageId null for an announcement. */
  speaking: { threadId: Id; messageId: Id | null; text: string } | null;
  /** Hands-free conversation in this thread. */
  talk: { threadId: Id } | null;
}

const PREF_KEY = 'vector.speakReplies';

function readPref(): boolean {
  try {
    return window.localStorage.getItem(PREF_KEY) === '1';
  } catch {
    return false;
  }
}

let state: VoiceOutState = { enabled: false, canSpeak: false, canTalk: false, speaking: null, talk: null };
const listeners = new Set<() => void>();

function set(patch: Partial<VoiceOutState>): void {
  state = { ...state, ...patch };
  for (const fn of [...listeners]) fn();
}

export function getVoiceOut(): VoiceOutState {
  return state;
}

export function useVoiceOut<T>(selector: (s: VoiceOutState) => T): T {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => selector(state),
  );
}

/** A reply that arrived while the app had not yet said whether it can speak: said once it has, if still wanted. */
let held: { text: string; threadId: Id; messageId: Id | null } | null = null;
let heldOpenThread: Id | null = null;

function refreshSupport(): void {
  const canSpeak = ttsMode() !== null;
  const canTalk = canSpeak && speechMode() !== null;
  if (canSpeak !== state.canSpeak || canTalk !== state.canTalk) set({ canSpeak, canTalk });
  if (held && !ttsUndecided()) {
    const { text, threadId, messageId } = held;
    held = null;
    if (canSpeak && audible(threadId, heldOpenThread)) say(text, threadId, messageId);
  }
}

let started = false;
/** Once, at startup: ask the app what it can do, and stop speaking when the user leaves the screen or the page. */
export function initVoiceOut(): void {
  if (started) return;
  started = true;
  state = { ...state, enabled: readPref() };
  onSpeechSupportChange(refreshSupport);
  probeNative();
  refreshSupport();
  window.addEventListener('hashchange', () => silence());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      silence();
      if (state.talk) endTalk();
    }
  });
}

export function setSpeakReplies(on: boolean): void {
  try {
    window.localStorage.setItem(PREF_KEY, on ? '1' : '0');
  } catch {
    // private mode: the preference lasts for this page only
  }
  if (!on) silence();
  set({ enabled: on });
}

// ───────────────────────── Which runs are ours ─────────────────────────

/** Threads where this client just asked for a run; the next run.started there is ours. */
const claims = new Set<Id>();
/** Assistant messages of runs this client started. */
const ownedMessages = new Set<Id>();
/** Threads with a run of ours in flight. */
const ownedThreads = new Set<Id>();

/** This client is starting a run in `threadId` (a message, an action button). */
export function claimRun(threadId: Id): void {
  claims.add(threadId);
  ownedThreads.add(threadId);
  // The run may already have started (an action's 202 can arrive after run.started): own what is streaming.
  const s = getState();
  for (const m of s.threads[threadId]?.messages ?? []) if (s.streaming[m.id]) ownedMessages.add(m.id);
}

function audible(threadId: Id | null | undefined, openThreadId: Id | null): boolean {
  if (!threadId || threadId !== openThreadId) return false;
  if (document.visibilityState !== 'visible') return false;
  return state.enabled || state.talk?.threadId === threadId;
}

/** Called by the event reducer after every server event. */
export function noteEvent(ev: ServerEvent, openThreadId: Id | null): void {
  switch (ev.type) {
    case 'run.started':
      if (claims.delete(ev.threadId)) {
        ownedMessages.add(ev.messageId);
        ownedThreads.add(ev.threadId);
      }
      return;
    case 'message.done':
      if (ownedMessages.has(ev.message.id) && audible(ev.threadId, openThreadId)) {
        const text = speakableReply(ev.message, getState().handoffs);
        if (text) say(text, ev.threadId, ev.message.id);
      }
      return;
    case 'approval.requested':
      if (ev.approval.threadId && ownedThreads.has(ev.approval.threadId) && audible(ev.approval.threadId, openThreadId)) {
        say(APPROVAL_LINE, ev.approval.threadId, null);
      }
      return;
    case 'run.finished':
      if (ownedThreads.has(ev.threadId) && ev.status === 'error' && audible(ev.threadId, openThreadId)) {
        say(RUN_FAILED_LINE, ev.threadId, null);
      }
      ownedThreads.delete(ev.threadId);
      claims.delete(ev.threadId);
      return;
    default:
      return;
  }
}

// ───────────────────────── Speaking ─────────────────────────

let current: Utterance | null = null;

function say(text: string, threadId: Id, messageId: Id | null): void {
  if (ttsUndecided()) {
    held = { text, threadId, messageId }; // hold it until the app says whether it can speak
    heldOpenThread = threadId;
    return;
  }
  const utterance = speakText(text, (error) => {
    if (current !== utterance) return;
    current = null;
    set({ speaking: null });
    if (error) {
      toast(error === 'busy' ? 'Voice output is busy' : 'Voice output is not available here', 'error');
      if (state.talk) endTalk();
    }
  });
  if (!utterance) return;
  current = utterance;
  set({ speaking: { threadId, messageId, text } });
}

/** Stop speaking now: the user tapped the mic, sent, stopped, tapped the indicator, or left. */
export function silence(): void {
  held = null;
  if (!current && !state.speaking) return;
  current = null;
  stopSpeaking();
  set({ speaking: null });
}

// ───────────────────────── Hands-free conversation ─────────────────────────

export function startTalk(threadId: Id): void {
  if (!state.canTalk) return;
  silence();
  set({ talk: { threadId } });
}

export function endTalk(): void {
  if (!state.talk) return;
  silence();
  set({ talk: null });
}
