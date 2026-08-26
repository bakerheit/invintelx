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
