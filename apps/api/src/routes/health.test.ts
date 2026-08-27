import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

/**
 * What the host polls.
 *
 * Deliberately run with no mongod, because the interesting half of a health
 * check is what it says when the database is gone. A process that is listening
 * but cannot read anything is not healthy, and a probe that only checked the
 * port would keep it in the load balancer.
 *
 * A fixture web build is mounted so that the other half is covered too: the
 * probe path must reach this route and not the single-page-app fallback, which
 * would answer every probe with 200 and an HTML page forever.
 */
let app: Express;
let dist: string;

beforeAll(async () => {
  dist = mkdtempSync(join(tmpdir(), 'invintelx-health-dist-'));
  mkdirSync(join(dist, 'assets'));
  writeFileSync(join(dist, 'index.html'), '<!doctype html><html><body>app</body></html>');

  process.env.NODE_ENV = 'test';
  process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/unused';
  process.env.SESSION_SECRET = 'test-secret-that-is-definitely-long-enough';
  process.env.WEB_DIST = dist;

  const { createApp } = await import('../app.js');
  app = createApp();
});

afterAll(() => {
  delete process.env.WEB_DIST;
});

describe('the health endpoint', () => {
  it('answers at /health, where a host looks by default', async () => {
    const response = await request(app).get('/health');
    expect(response.headers['content-type']).toMatch(/application\/json/);
    expect(response.body).toHaveProperty('status');
  });

  it('still answers at /api/health, which the docs and tooling name', async () => {
    const response = await request(app).get('/api/health');
    expect(response.headers['content-type']).toMatch(/application\/json/);
    expect(response.body).toHaveProperty('status');
  });

  it('reports the same thing at both, because they are one handler', async () => {
    const bare = await request(app).get('/health');
    const prefixed = await request(app).get('/api/health');
    expect(bare.status).toBe(prefixed.status);
    expect(bare.body.version).toBe(prefixed.body.version);
    expect(bare.body.database).toBe(prefixed.body.database);
  });

  it('is not shadowed by the single-page-app fallback', async () => {
    // The failure this exists for: /health falls through to index.html, every
    // probe gets 200 and a web page, and a dead instance stays in rotation.
    const response = await request(app).get('/health');
    expect(response.headers['content-type']).not.toMatch(/text\/html/);
  });

  it('fails the probe when the database is unreachable', async () => {
    const response = await request(app).get('/health');
    expect(response.status).toBe(503);
    expect(response.body.status).toBe('degraded');
    expect(response.body.database).toBe(false);
  });

  it('reports the running version even while degraded', async () => {
    // The instance being reported is the broken one, so this is exactly when
    // "which release is this" gets asked.
    const { VERSION } = await import('../version.js');
    const response = await request(app).get('/health');
    expect(response.body.version).toBe(VERSION);
  });

  it('needs no session, because an operator locked out still has to ask', async () => {
    const response = await request(app).get('/health');
    expect(response.status).not.toBe(401);
    expect(response.body).toHaveProperty('uptimeSeconds');
  });

  it('carries a request id like everything else', async () => {
    const response = await request(app).get('/health');
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});
