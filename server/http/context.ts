import type { AgentRuntime, HandoffRuntime } from '../core/runtime.ts';
import type { StreamRegistry } from './sse.ts';

export interface AppDeps {
  agent: AgentRuntime;
  handoff: HandoffRuntime;
  scheduler?: { refresh(): void };
}

/** What every route module receives. */
export interface AppContext extends AppDeps {
  streams: StreamRegistry;
}
