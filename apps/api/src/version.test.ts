import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
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
