import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import { envSchema } from './envSchema.js';

/*
 * The .env lives at the monorepo root, but this process runs with apps/api as
 * its cwd. Resolve relative to this file instead so `pnpm seed`, `pnpm dev` and
 * `node dist/index.js` all find the same file.
 *
 * Real environment variables always win, which is what production uses.
 */
config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env') });

/**
 * Parsed once at import. A missing or malformed variable kills the process at
 * boot with a readable message, rather than surfacing as a confusing failure on
 * whichever request happens to touch it first.
 *
 * The schema itself lives in `envSchema.ts`, where it can be imported without
 * any of this happening - which is what lets `docs/configuration.md` be
 * generated from it.
 */
const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  console.error(
    `Invalid environment configuration:\n${issues}\n\n` +
      `See .env.example, or docs/configuration.md for what each variable does.`,
  );
  process.exit(1);
}

export const env = parsed.data;
export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
