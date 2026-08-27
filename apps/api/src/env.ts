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

/** Applied outside production only - see MONGODB_DB below. */
const DEFAULT_MONGODB_DB = 'invintelx';

/**
 * What this process requires of its environment, and therefore the only
 * description of it that cannot go out of date. A missing or malformed variable
 * kills the process at boot with a readable message, rather than surfacing as a
 * confusing failure on whichever request happens to touch it first.
 */
const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3001),

    /**
     * A whole connection string, not a hostname. A hosted cluster hands you a
     * `mongodb+srv://` one with the password already in it, which is why the
     * variable is a secret in full rather than a secret with a URL around it.
     */
    MONGODB_URI: z
      .string()
      .min(1, 'MONGODB_URI is required')
      .refine((uri) => uri.startsWith('mongodb://') || uri.startsWith('mongodb+srv://'), {
        message: 'MONGODB_URI must be a mongodb:// or mongodb+srv:// connection string',
      }),

    /**
     * Which database on that server. Any database named in the connection
     * string's path is ignored - `client.db()` is given this.
     *
     * Deliberately not `.default()`: production and staging are the same build
     * against the same cluster, told apart by nothing but this name, so a
     * default that applied in production is a staging deploy writing to
     * production's collections. The refinement below is what stops that; the
     * default is applied afterwards, for development and test only.
     */
    MONGODB_DB: z.string().min(1).optional(),

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
  })
  .superRefine((value, ctx) => {
    if (value.NODE_ENV === 'production' && value.MONGODB_DB === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MONGODB_DB'],
        message:
          'MONGODB_DB must be set explicitly when NODE_ENV=production - production and staging ' +
          'are told apart by database name alone, so falling back to a default would point a ' +
          "staging deploy at production's data",
      });
    }
  });

/**
 * The parsed environment. `MONGODB_DB` is widened back to required because the
 * default is applied below rather than by the schema.
 */
export type Env = Omit<z.infer<typeof envSchema>, 'MONGODB_DB'> & { MONGODB_DB: string };

export type EnvResult = { ok: true; env: Env } | { ok: false; problems: string[] };

/**
 * Pure, and exported so the rules above can be tested against environments this
 * process is not running in - a production one especially, which is the case
 * nobody wants to discover by deploying it.
 *
 * Every problem is reported, not the first: an operator fixing one variable per
 * restart is the failure mode this is meant to avoid.
 */
export function parseEnv(source: NodeJS.ProcessEnv): EnvResult {
  const parsed = envSchema.safeParse(source);

  if (!parsed.success) {
    return {
      ok: false,
      problems: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    };
  }

  return {
    ok: true,
    env: { ...parsed.data, MONGODB_DB: parsed.data.MONGODB_DB ?? DEFAULT_MONGODB_DB },
  };
}

/** Parsed once at import, so a bad environment stops the boot and not a request. */
const result = parseEnv(process.env);

if (!result.ok) {
  const issues = result.problems.map((p) => `  - ${p}`).join('\n');
  console.error(`Invalid environment configuration:\n${issues}\n\nSee .env.example.`);
  process.exit(1);
}

export const env = result.env;
export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
