import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

/**
 * A fixture web build rather than the real one: these tests are about the
 * routing rules around `dist`, not about what Vite emits, and depending on a
 * real build would make the suite require `pnpm build` to have been run.
 *
 * No mongod here either. Nothing exercised below reaches the database - an
 * unauthenticated request carries no session cookie, so `loadUser` returns
 * before it queries anything.
 */
let app: Express;
let dist: string;

const INDEX_HTML = '<!doctype html><html><body><div id="root"></div></body></html>';
const HASHED_ASSET = 'assets/index-B7f3Kq2x.js';

beforeAll(async () => {
  dist = mkdtempSync(join(tmpdir(), 'invintelx-web-dist-'));
  mkdirSync(join(dist, 'assets'));
  writeFileSync(join(dist, 'index.html'), INDEX_HTML);
  writeFileSync(join(dist, HASHED_ASSET), 'console.log("app");\n');
  writeFileSync(join(dist, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');

  // env.ts parses at import time, so these have to be set before it loads.
  process.env.NODE_ENV = 'test';
  process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/unused';
  process.env.SESSION_SECRET = 'test-secret-that-is-definitely-long-enough';
  process.env.WEB_DIST = dist;

  const { createApp } = await import('./app.js');
  app = createApp();
});

afterAll(() => {
  delete process.env.WEB_DIST;
});

describe('serving the built web app', () => {
  it('serves index.html at the root', async () => {
    const response = await request(app).get('/').expect(200);
    expect(response.headers['content-type']).toMatch(/text\/html/);
    expect(response.text).toContain('<div id="root">');
  });

  it('serves index.html for a client-side route, so a refresh survives', async () => {
    for (const path of ['/dashboard', '/items', '/items/6512c0ffee0000000000beef', '/login']) {
      const response = await request(app).get(path).expect(200);
      expect(response.headers['content-type']).toMatch(/text\/html/);
      expect(response.text).toContain('<div id="root">');
    }
  });

  it('serves a hashed asset with its own content type', async () => {
    const response = await request(app).get(`/${HASHED_ASSET}`).expect(200);
    expect(response.headers['content-type']).toMatch(/javascript/);
    expect(response.text).toContain('console.log');
  });

  it('lets a hashed asset be cached forever but always revalidates index.html', async () => {
    const asset = await request(app).get(`/${HASHED_ASSET}`).expect(200);
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');

    // The entry point keeps its name across releases. Cache it and an upgrade
    // never reaches a browser that has been here before.
    const index = await request(app).get('/dashboard').expect(200);
    expect(index.headers['cache-control']).toBe('no-cache');

    // Same for anything copied out of public/ - the name does not change.
    const favicon = await request(app).get('/favicon.svg').expect(200);
    expect(favicon.headers['cache-control']).toBe('no-cache');
  });
});

describe('what the fallback must not swallow', () => {
  it('still answers an unknown /api path with the JSON error envelope', async () => {
    const response = await request(app).get('/api/nope').expect(404);
    expect(response.headers['content-type']).toMatch(/application\/json/);
    expect(response.body.error.code).toBe('not_found');
  });

  it('does not serve HTML for a missing hashed asset', async () => {
    const response = await request(app).get('/assets/index-GONE1234.js').expect(404);
    expect(response.headers['content-type']).toMatch(/application\/json/);
    expect(response.body.error.code).toBe('not_found');
  });

  it('does not answer a non-GET request with a page', async () => {
    const response = await request(app).post('/items').send({}).expect(404);
    expect(response.headers['content-type']).toMatch(/application\/json/);
    expect(response.body.error.code).toBe('not_found');
  });

  it('serves the API health check rather than a file', async () => {
    // Reaches the database, so the status may be 200 or 503 - the point is that
    // it is the health route answering and not index.html.
    const response = await request(app).get('/api/health');
    expect(response.headers['content-type']).toMatch(/application\/json/);
    expect(response.body).toHaveProperty('uptimeSeconds');
  });

  it('reports the running version there, unauthenticated', async () => {
    // The first question of every deployment bug report, and the operator
    // asking it may not have an account. Reported whether the database is up
    // or not, because a degraded instance is the one being reported.
    const { VERSION } = await import('./version.js');
    const response = await request(app).get('/api/health');
    expect(response.body.version).toBe(VERSION);
    expect(response.body.version).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('finding the build without being told where it is', () => {
  it('looks in apps/web/dist, which is where pnpm build puts it', async () => {
    const { DEFAULT_WEB_DIST } = await import('./web.js');
    // The same relative hop has to land here from src/ under tsx and from
    // dist/ after a build, which it does because both sit one level under
    // apps/api. Move this file and that stops being true.
    expect(isAbsolute(DEFAULT_WEB_DIST)).toBe(true);
    expect(DEFAULT_WEB_DIST.endsWith(join('apps', 'web', 'dist'))).toBe(true);
  });

  it('refuses to boot if WEB_DIST names a directory that is not a build', async () => {
    const { webAssets } = await import('./web.js');
    const empty = mkdtempSync(join(tmpdir(), 'invintelx-not-a-build-'));
    expect(() => webAssets(empty)).toThrow(/no index\.html/);
  });
});
