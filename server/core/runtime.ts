import type { ChatMessage, HandoffRun, Id } from '../../shared/types.ts';

/** Implemented by server/agent, consumed by server/http and the scheduler. */
export interface AgentRuntime {
  /**
   * Persist `text` as a user message in the thread, publish `message.created`, then run the agent
   * in the background, streaming over the event bus. Throws AgentBusyError if the thread already
   * has a run in flight.
   */
  startTurn(opts: {
    userId: Id;
    threadId: Id;
    text: string;
    source?: ChatMessage['source'];
    /** True for scheduled runs: nobody is watching, approvals wait in the inbox. */
    unattended?: boolean;
  }): { runId: Id; done: Promise<'ok' | 'error' | 'cancelled'> };
  cancel(userId: Id, threadId: Id): void;
  isRunning(threadId: Id): boolean;
  /** Abort every run of a user (account deletion). */
  cancelAll(userId: Id): void;
}

export class AgentBusyError extends Error {
  constructor() {
    super('This thread is already working on something.');
  }
}

/** Implemented by server/handoff. */
export interface HandoffRuntime {
  /**
   * Drive a real browser toward `goal`. Resolves with a text result for the calling agent.
   * Publishes `handoff.update` after every step. Must honour `signal`.
   */
  run(opts: {
    userId: Id;
    threadId: Id | null;
    goal: string;
    startUrl?: string;
    signal: AbortSignal;
    unattended?: boolean;
    /** Called as soon as the run row exists, so the chat can show the live view. */
    onStart?: (runId: Id) => void;
  }): Promise<{
    runId: Id;
    status: HandoffRun['status'];
    result: string;
  }>;
  /** Latest JPEG frame of a run owned by this user, or null. */
  screenshot(userId: Id, runId: Id): Buffer | null;
  cancel(userId: Id, runId: Id): void;
  cancelAll(userId: Id): void;
}
