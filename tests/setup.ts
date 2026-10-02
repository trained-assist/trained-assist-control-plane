import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll } from 'vitest';
import { env } from './env';

beforeAll(async () => {
  const migrations = env.MIGRATIONS ?? [];
  if (migrations.length > 0) {
    await applyD1Migrations(env.DB, migrations);
  }
});
