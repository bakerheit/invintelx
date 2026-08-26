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
  /*
   * Where the built web app lives, for the single-origin deployment where this
   * process serves it. Unset means "look next door at apps/web/dist, and if
   * there is nothing there serve only /api" - which is the development case,
   * and the case where a reverse proxy serves the assets instead.
   */
  WEB_DIST: z.string().min(1).optional(),

  /**
   * How an instance gets its first administrator.
   *
   * 'token' (the default): registration is refused until it presents the setup
   * token minted at boot and printed to the server log. Deploying an instance
   * and becoming its administrator are then two separate acts, so whoever
   * reaches an exposed instance first cannot take it over.
   *
   * 'open': the first account to register becomes the administrator with no
   * token at all. That is a deliberate choice for a public sign-up product like
   * invintelx.org; on anything else it is a takeover window that opens the
   * moment the container is reachable.
   */
  FIRST_ADMIN_SETUP: z.enum(['token', 'open']).default('token'),

  /**
   * Pins the setup token instead of letting one be minted at boot, for deploys
   * where reading the container log is awkward and a secret is easier to inject.
   * Ignored entirely once the instance has an account.
   */
  SETUP_TOKEN: z.string().min(16, 'SETUP_TOKEN must be at least 16 characters').optional(),
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
