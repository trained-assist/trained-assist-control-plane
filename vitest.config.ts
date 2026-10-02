import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { existsSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => {
  const migrations = existsSync('migrations') ? await readD1Migrations('migrations') : [];
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: { bindings: { MIGRATIONS: migrations } },
      }),
    ],
    test: {
      setupFiles: ['./tests/setup.ts'],
      testTimeout: 60_000,
      hookTimeout: 60_000,
      include: ['tests/**/*.test.ts'],
    },
  };
});
