import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import { z } from 'zod';

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
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),
  MONGODB_DB: z.string().min(1).default('invintelx'),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  WEB_ORIGIN: z.string().url().default('http://localhost:5173'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  console.error(`Invalid environment configuration:\n${issues}\n\nSee .env.example.`);
  process.exit(1);
}

export const env = parsed.data;
export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
