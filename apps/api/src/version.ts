import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `apps/api/package.json` relative to this file. The same relative hop lands in
 * the right place whether this module runs from `src` under tsx or from `dist`
 * after `pnpm build`, because both sit one level under `apps/api` — the same
 * reason `DEFAULT_WEB_DIST` works. Move this file and that stops being true.
 */
export const PACKAGE_JSON = resolve(dirname(fileURLToPath(import.meta.url)), '../package.json');

/**
 * The release this instance is running, reported at `/api/health` so a bug
 * report can say which version it is against. Kept in step with the tag by
 * `scripts/release/check-release.mjs`, which refuses a release where any
 * package.json disagrees with the tag being pushed.
 *
 * `unknown` rather than a plausible-looking number when it cannot be read: a
 * version that is a guess is worse than no version, because somebody will
 * reproduce a bug against it.
 */
export const VERSION = readVersion();

/**
 * What an acceptable revision looks like: a git sha, long or short, or a tag-ish
 * label somebody's pipeline substitutes instead.
 *
 * Checked rather than trusted because this value is minted by whatever built the
 * image and then published, unauthenticated, to anyone who can reach `/health`.
 * Bounded and alphabet-restricted, so what a probe reads back is a build
 * identifier and not an essay a build script accidentally interpolated.
 */
const SAFE_REVISION = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * The commit this build came from, or `unknown`.
 *
 * `VERSION` answers "which release", and two commits on the same release are
 * identical from outside - which is exactly the pair a deploy or a rollback sits
 * between. This answers "which build", so a smoke check can tell the difference.
 *
 * `unknown` for the same reason `VERSION` uses it: a build identifier that is a
 * guess is worse than none, because somebody will go looking for that commit.
 *
 * Read straight from `process.env` rather than through `env.ts`, which is the
 * one place in this app that does. Two reasons, and both are about that module's
 * contract rather than about convenience:
 *
 *   - Everything in `env.ts` is validated with a schema whose failure mode is
 *     `process.exit(1)` at boot. A build label must never be able to do that: an
 *     image built by hand has no sha to offer, and a pipeline that interpolates
 *     a broken one should cost an answer at `/health`, not the instance.
 *   - This module describes the build, not the configuration, and stays
 *     importable without standing configuration up at all - which is what lets
 *     the release tooling and `version.test.ts` read it directly.
 */
export const REVISION = readRevision();

function readRevision(): string {
  const raw = process.env.BUILD_REVISION?.trim();
  if (raw === undefined || raw === '') return 'unknown';
  return SAFE_REVISION.test(raw) ? raw : 'unknown';
}

function readVersion(): string {
  try {
    const parsed: unknown = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8'));
    const version =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as { version?: unknown }).version
        : undefined;
    return typeof version === 'string' && version !== '' ? version : 'unknown';
  } catch {
    return 'unknown';
  }
}
