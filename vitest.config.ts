import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./apps/web/src', import.meta.url)),
      /*
       * packages/shared has two entry points: its TypeScript source, and the
       * JavaScript it compiles to for the container image, which Node picks up
       * under the `production` condition. The suite always takes the source.
       *
       * Explicit rather than left to Vite's condition defaults for the same
       * reason `webAssets` ignores a stray dist in development: a build lying
       * around must not change what the tests exercise. CI also runs `test`
       * before `build`, so here that directory does not exist at all.
       */
      '@invintelx/shared': fileURLToPath(
        new URL('./packages/shared/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: [
      'packages/*/src/**/*.test.{ts,tsx}',
      'apps/*/src/**/*.test.{ts,tsx}',
      // Release tooling. It decides whether a tag gets published, so the rules
      // it enforces are tested here rather than discovered by a bad release.
      'scripts/**/*.test.mjs',
    ],
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
