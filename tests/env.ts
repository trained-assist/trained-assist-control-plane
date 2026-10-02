import { env as workersEnv, type D1Migration } from 'cloudflare:test';

export interface TestEnv {
  DB: D1Database;
  TASK_WORKFLOW: Workflow;
  MIGRATIONS: D1Migration[];
}

/** Bindings declared in wrangler.jsonc, typed for tests. */
export const env = workersEnv as unknown as TestEnv;
