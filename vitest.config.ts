import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/api/src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // The API suite boots a real mongod, which is slower than a mock and worth it.
    testTimeout: 30_000,
    hookTimeout: 120_000,
    // One mongod per file, and files sharing a database would race on the
    // per-test wipe. Keep them sequential.
    fileParallelism: false,
  },
});
