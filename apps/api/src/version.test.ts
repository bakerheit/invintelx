import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PACKAGE_JSON, VERSION } from './version.js';

/*
 * That /api/health actually carries this is asserted in web.test.ts, where an
 * app is already stood up. Here it is only the version itself: which file it
 * comes from, and that it is a real number rather than the fallback.
 */
describe('the version this instance reports', () => {
  it('resolves apps/api/package.json, the same hop from src and from dist', () => {
    // Both `src` and `dist` sit one level under `apps/api`, so `../package.json`
    // is the same file either way. If this fails, the module moved.
    expect(PACKAGE_JSON.endsWith(join('apps', 'api', 'package.json'))).toBe(true);
    expect(VERSION).toBe(JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')).version);
  });

  it('is a version number, not the fallback', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});

/**
 * Which build is running, and what happens when nothing told us.
 *
 * `REVISION` is read once at import, so every case here re-imports the module
 * with a different environment rather than reassigning anything. The statically
 * imported `VERSION` above is unaffected: it is already bound.
 */
async function revisionWith(value: string | undefined): Promise<string> {
  vi.resetModules();
  if (value === undefined) delete process.env.BUILD_REVISION;
  else process.env.BUILD_REVISION = value;
  const { REVISION } = await import('./version.js');
  return REVISION;
}

describe('the build revision', () => {
  /*
   * No database URI or session secret set up here, unlike every other suite that
   * imports part of the API. That is the point of `version.ts` importing nothing
   * from `env.ts`: reading which build this is does not require a configured
   * process, and this file re-importing the module seven times would otherwise
   * re-run the env schema - whose failure mode is `process.exit(1)` - each time.
   */
  afterEach(() => {
    delete process.env.BUILD_REVISION;
    vi.resetModules();
  });

  it('reports a full git sha as given', async () => {
    await expect(revisionWith('b43576b2ec7e11db808edf819c18b0a170c2b7c1')).resolves.toBe(
      'b43576b2ec7e11db808edf819c18b0a170c2b7c1',
    );
  });

  it('reports a short sha too, because that is what a pipeline usually passes', async () => {
    await expect(revisionWith('b43576b')).resolves.toBe('b43576b');
  });

  it('accepts a tag-ish label, for a pipeline that stamps one instead', async () => {
    await expect(revisionWith('v1.4.0-rc.2')).resolves.toBe('v1.4.0-rc.2');
  });

  it('is unknown when nothing set it', async () => {
    // An image built outside the pipeline has no sha to offer. Saying so is the
    // honest answer; inventing one would send somebody looking for a commit
    // that does not exist.
    await expect(revisionWith(undefined)).resolves.toBe('unknown');
  });

  it('is unknown when the build substituted an empty string', async () => {
    // `--build-arg BUILD_REVISION=$UNSET_VAR` is the common way to get here, and
    // it must not publish an empty field that reads as a real answer.
    await expect(revisionWith('')).resolves.toBe('unknown');
    await expect(revisionWith('   ')).resolves.toBe('unknown');
  });

  it('refuses a value that is not a build identifier', async () => {
    /*
     * This field is published unauthenticated to anyone who can reach /health.
     * What arrives here was minted by a build script, so the failure mode is a
     * script interpolating something enormous or newline-ridden rather than an
     * attacker - but the endpoint should still report a build identifier or
     * nothing at all.
     */
    await expect(revisionWith('not a sha')).resolves.toBe('unknown');
    await expect(revisionWith('b43576b\nrogue: line')).resolves.toBe('unknown');
    await expect(revisionWith('a'.repeat(65))).resolves.toBe('unknown');
  });

  it('trims whitespace, because `git rev-parse HEAD` ends in a newline', async () => {
    // The single most likely way this variable gets set by hand in a shell.
    await expect(revisionWith('b43576b\n')).resolves.toBe('b43576b');
  });
});
