import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./apps/web/src', import.meta.url)),
    },
  },
  test: {
    include: ['packages/*/src/**/*.test.{ts,tsx}', 'apps/*/src/**/*.test.{ts,tsx}'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    /*
     * Node by default; only the web app needs a DOM. Scoping it this way keeps
     * the API suite off a DOM it does not need.
     *
     * happy-dom rather than jsdom: react-router builds requests through undici,
     * whose Request rejects jsdom's AbortSignal because it is not an instance
     * of Node's. Any test touching a loader dies on that.
     */
    environmentMatchGlobs: [['apps/web/**', 'happy-dom']],
    setupFiles: ['./vitest.setup.ts'],
    // The API suite boots a real mongod, which is slower than a mock and worth it.
    testTimeout: 30_000,
    hookTimeout: 120_000,
    // One mongod per file, and files sharing a database would race on the
    // per-test wipe. Keep them sequential.
    fileParallelism: false,
  },
});
