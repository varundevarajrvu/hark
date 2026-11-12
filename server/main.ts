import { config, credentialsHint, ensureDataDir, hasLlmCredentials, masterKey } from './core/config.ts';
import { db } from './core/db.ts';
import { createAgentRuntime } from './agent/index.ts';
import { createHandoffRuntime } from './handoff/index.ts';
import { buildApp } from './http/app.ts';
import { startScheduler } from './http/scheduler.ts';

ensureDataDir();
masterKey(); // fail fast on a bad key
db(); // create / migrate the schema

const handoff = createHandoffRuntime();
const agent = createAgentRuntime({ handoff });
const scheduler = startScheduler({ agent });
const app = await buildApp({ agent, handoff, scheduler });

await app.listen({ port: config.port, host: config.host });

const llm = config.mockLlm ? 'offline demo model (VECTOR_MOCK_LLM=1)' : hasLlmCredentials() ? `${config.model} (${config.provider})` : `NO CREDENTIALS — ${credentialsHint()}`;
console.log(`Vector is listening on http://${config.host}:${config.port}\n  model: ${llm}\n  data:  ${config.dataDir}`);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, async () => {
    scheduler.stop();
    await app.close().catch(() => {});
    process.exit(0);
  });
}
