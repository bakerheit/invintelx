import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

/**
 * The health response as a wire format, with a reachable database.
 *
 * `health.test.ts` covers the interesting half - what the endpoint says when
 * Mongo is gone. This covers the half that is boring to read and expensive to
 * break: the exact bytes two things outside this repository match against.
 *
 *   - the image's `HEALTHCHECK`, which fetches `/api/health` and fails the
 *     container on any non-2xx;
 *   - the container smoke job in CI, which greps the body for `"status":"ok"`
 *     and `"database":true` as literal substrings.
 *
 * Both were written against the handler this branch replaced, and neither has
 * ever run against the replacement - they live on branches that are not merged
 * yet, so nothing in this repository would notice the day the two disagree.
 * Renaming a field, or answering `healthy` instead of `ok`, passes every other
 * test here and fails the release. This is that check, run in the suite.
 */
let app: Express;

vi.mock('../db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db.js')>();
  // Only the probe is faked. Everything else stays real, because the rest of
  // the app is still wired up around it and a hollowed-out module would make
  // this test pass for the wrong reason.
  return { ...actual, healthcheck: () => Promise.resolve(true) };
});

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/unused';
  process.env.SESSION_SECRET = 'test-secret-that-is-definitely-long-enough';

  const { createApp } = await import('../app.js');
  app = createApp();
});

afterAll(() => {
  vi.restoreAllMocks();
});

describe('what a host reads back from the health endpoint', () => {
  it('answers 200 when the database is reachable', async () => {
    // The image HEALTHCHECK's whole test is `r.ok`. Anything else marks the
    // container unhealthy and, on a platform that restarts unhealthy
    // containers, turns a working deploy into a crash loop.
    const response = await request(app).get('/api/health');
    expect(response.status).toBe(200);
  });

  it('serialises the two substrings the container smoke job greps for', async () => {
    /*
     * Asserted against the raw text on purpose. `response.body.status === 'ok'`
     * would still pass if Express started pretty-printing the JSON, and
     * `grep -q '"status":"ok"'` would not.
     */
    const response = await request(app).get('/api/health');
    expect(response.text).toContain('"status":"ok"');
    expect(response.text).toContain('"database":true');
  });

  it('says the same at /health, which is the other path one handler serves', async () => {
    const response = await request(app).get('/health');
    expect(response.status).toBe(200);
    expect(response.text).toContain('"status":"ok"');
    expect(response.text).toContain('"database":true');
  });

  it('never reports the version as unknown from a real checkout', async () => {
    // CI fails the image on `"version":"unknown"`, because that is what losing
    // apps/api/package.json out of the image looks like from outside, and
    // nobody would notice until a bug report quoted it.
    const response = await request(app).get('/api/health');
    expect(response.body.version).not.toBe('unknown');
  });

  it('names the build as well as the release', async () => {
    // Two commits on one version are the same release and different code. A
    // rollback moves this field and leaves `version` alone, which is the only
    // way a probe can tell that the rollback took.
    const response = await request(app).get('/api/health');
    expect(response.body).toHaveProperty('revision');
    expect(typeof response.body.revision).toBe('string');
  });
});
