import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { existsSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => {
  const migrations = existsSync('migrations') ? await readD1Migrations('migrations') : [];
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          bindings: { MIGRATIONS: migrations },
          serviceBindings: { INGRESS_BUFFER: async () => Response.json({ error: 'buffer fixture unavailable' }, { status: 503 }) },
        },
      }),
    ],
    test: {
      setupFiles: ['./tests/setup.ts'],
      // Файлы делят один miniflare-рантайм (D1, Workflows): abortAllDurableObjects
      // в одном файле убил бы экземпляры соседнего. Последовательно — намеренно.
      fileParallelism: false,
      testTimeout: 60_000,
      hookTimeout: 60_000,
      include: ['tests/**/*.test.ts'],
    },
  };
});
