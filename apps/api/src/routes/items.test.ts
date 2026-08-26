import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import request from 'supertest';
import type { Express } from 'express';
import type * as DbModule from '../db.js';

/**
 * Integration tests against a real mongod. A mock would happily agree that a
 * duplicate SKU is fine; only the actual unique index proves otherwise, and
 * that guarantee is the point of several of these tests.
 */
let replSet: MongoMemoryReplSet;
let app: Express;
// Imported dynamically inside beforeAll, after the env vars are set, but typed
// statically here so the tests still get real types off the module.
let db: typeof DbModule;

const CREDENTIALS = { email: 'tester@invintelx.org', name: 'Tester', password: 'a-long-enough-password' };

async function signIn(): Promise<string> {
  const response = await request(app).post('/api/auth/register').send(CREDENTIALS).expect(201);
  const cookies = response.headers['set-cookie'];
  const header = Array.isArray(cookies) ? cookies[0] : cookies;
  if (!header) throw new Error('register did not set a session cookie');
  return header.split(';')[0] ?? '';
}

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });

  // env.ts parses at import time, so these have to be set before it loads.
  process.env.NODE_ENV = 'test';
  process.env.MONGODB_URI = replSet.getUri();
  process.env.MONGODB_DB = 'invintelx_test';
  process.env.SESSION_SECRET = 'test-secret-that-is-definitely-long-enough';
  // These tests are about items, not about claiming an instance, so they use
  // the open bootstrap and register their way to an admin. The token bootstrap
  // that a self-hosted instance gets by default is auth.setup.test.ts.
  process.env.FIRST_ADMIN_SETUP = 'open';

  db = await import('../db.js');
  await db.connect();
  await db.ensureIndexes();

  const { createApp } = await import('../app.js');
  app = createApp();
}, 120_000);

afterAll(async () => {
  await db?.disconnect();
  await replSet?.stop();
});

beforeEach(async () => {
  await Promise.all([
    db.items().deleteMany({}),
    db.users().deleteMany({}),
    db.sessions().deleteMany({}),
  ]);
});

describe('auth', () => {
  it('with the open bootstrap, makes the first registered user an admin and everyone after a member', async () => {
    const first = await request(app).post('/api/auth/register').send(CREDENTIALS).expect(201);
    expect(first.body.user.role).toBe('admin');

    const second = await request(app)
      .post('/api/auth/register')
      .send({ ...CREDENTIALS, email: 'second@invintelx.org' })
      .expect(201);
    expect(second.body.user.role).toBe('member');
  });

  it('never returns the password hash', async () => {
    const response = await request(app).post('/api/auth/register').send(CREDENTIALS).expect(201);
    expect(JSON.stringify(response.body)).not.toContain('argon2');
    expect(response.body.user.passwordHash).toBeUndefined();
  });

  it('gives the same rejection for a wrong password and an unknown email', async () => {
    await request(app).post('/api/auth/register').send(CREDENTIALS).expect(201);

    const wrongPassword = await request(app)
      .post('/api/auth/login')
      .send({ email: CREDENTIALS.email, password: 'not-the-password' })
      .expect(401);
    const unknownEmail = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nobody@invintelx.org', password: 'not-the-password' })
      .expect(401);

    expect(wrongPassword.body.error.message).toBe(unknownEmail.body.error.message);
  });

  it('normalises email case so one address cannot register twice', async () => {
    await request(app).post('/api/auth/register').send(CREDENTIALS).expect(201);
    await request(app)
      .post('/api/auth/register')
      .send({ ...CREDENTIALS, email: 'TESTER@INVINTELX.ORG' })
      .expect(409);
  });

  it('rejects a short password', async () => {
    const response = await request(app)
      .post('/api/auth/register')
      .send({ ...CREDENTIALS, password: 'short' })
      .expect(400);
    expect(response.body.error.fields.password).toBeDefined();
  });
});

describe('items', () => {
  it('requires authentication', async () => {
    await request(app).get('/api/items').expect(401);
  });

  it('creates, uppercases the SKU, and lists', async () => {
    const cookie = await signIn();

    const created = await request(app)
      .post('/api/items')
      .set('Cookie', cookie)
      .send({ sku: 'widget-1', name: 'Widget', unitCostCents: 1250 })
      .expect(201);
    expect(created.body.sku).toBe('WIDGET-1');

    const list = await request(app).get('/api/items').set('Cookie', cookie).expect(200);
    expect(list.body.total).toBe(1);
    expect(list.body.data[0].sku).toBe('WIDGET-1');
  });

  it('rejects a duplicate SKU with a 409 the form can render', async () => {
    const cookie = await signIn();
    await request(app)
      .post('/api/items')
      .set('Cookie', cookie)
      .send({ sku: 'dupe-1', name: 'First' })
      .expect(201);

    const conflict = await request(app)
      .post('/api/items')
      .set('Cookie', cookie)
      .send({ sku: 'DUPE-1', name: 'Second' })
      .expect(409);
    expect(conflict.body.error.fields.sku).toBeDefined();
  });

  it('returns per-field messages for invalid input', async () => {
    const cookie = await signIn();
    const response = await request(app)
      .post('/api/items')
      .set('Cookie', cookie)
      .send({ sku: 'bad sku', name: '', unitCostCents: -1 })
      .expect(400);

    expect(Object.keys(response.body.error.fields)).toEqual(
      expect.arrayContaining(['sku', 'name', 'unitCostCents']),
    );
  });

  it('hides archived items by default and finds them on request', async () => {
    const cookie = await signIn();
    const created = await request(app)
      .post('/api/items')
      .set('Cookie', cookie)
      .send({ sku: 'gone-1', name: 'Soon archived' })
      .expect(201);

    await request(app)
      .post(`/api/items/${created.body.id}/archive`)
      .set('Cookie', cookie)
      .expect(200);

    const active = await request(app).get('/api/items').set('Cookie', cookie).expect(200);
    expect(active.body.total).toBe(0);

    const archived = await request(app)
      .get('/api/items?status=archived')
      .set('Cookie', cookie)
      .expect(200);
    expect(archived.body.total).toBe(1);

    // Archiving is reversible; the item was never actually removed.
    await request(app)
      .post(`/api/items/${created.body.id}/restore`)
      .set('Cookie', cookie)
      .expect(200);
    const restored = await request(app).get('/api/items').set('Cookie', cookie).expect(200);
    expect(restored.body.total).toBe(1);
  });

  it('treats regex metacharacters in search as literal text', async () => {
    const cookie = await signIn();
    await request(app)
      .post('/api/items')
      .set('Cookie', cookie)
      .send({ sku: 'plain-1', name: 'Plain item' })
      .expect(201);

    // '.*' would match everything if it reached the regex engine unescaped.
    const response = await request(app).get('/api/items?q=.*').set('Cookie', cookie).expect(200);
    expect(response.body.total).toBe(0);
  });

  it('paginates without dropping or repeating rows across pages', async () => {
    const cookie = await signIn();
    for (let i = 1; i <= 7; i += 1) {
      await request(app)
        .post('/api/items')
        .set('Cookie', cookie)
        .send({ sku: `page-${i}`, name: `Item ${i}` })
        .expect(201);
    }

    const first = await request(app)
      .get('/api/items?pageSize=3&page=1&sort=sku&order=asc')
      .set('Cookie', cookie)
      .expect(200);
    const second = await request(app)
      .get('/api/items?pageSize=3&page=2&sort=sku&order=asc')
      .set('Cookie', cookie)
      .expect(200);

    expect(first.body.total).toBe(7);
    expect(first.body.totalPages).toBe(3);
    const skus = [...first.body.data, ...second.body.data].map((i: { sku: string }) => i.sku);
    expect(new Set(skus).size).toBe(6);
  });

  it('404s on an id that is not a valid ObjectId rather than throwing', async () => {
    const cookie = await signIn();
    await request(app).get('/api/items/not-a-real-id').set('Cookie', cookie).expect(404);
  });

  it('refuses writes from a viewer but still allows reads', async () => {
    const cookie = await signIn();

    // Demote the caller. requireRole is the only thing standing between a
    // read-only account and the write endpoints, so prove it actually stands.
    await db.users().updateOne({}, { $set: { role: 'viewer' } });

    await request(app).get('/api/items').set('Cookie', cookie).expect(200);
    await request(app)
      .post('/api/items')
      .set('Cookie', cookie)
      .send({ sku: 'nope-1', name: 'Should not be created' })
      .expect(403);
  });

  it('lets an admin through a member-level gate, since roles are ranked', async () => {
    const cookie = await signIn();
    // The first registered user is already an admin, and admin outranks member.
    await request(app)
      .post('/api/items')
      .set('Cookie', cookie)
      .send({ sku: 'admin-ok-1', name: 'Created by an admin' })
      .expect(201);
  });

  it('ends the session on logout', async () => {
    const cookie = await signIn();
    await request(app).get('/api/items').set('Cookie', cookie).expect(200);
    await request(app).post('/api/auth/logout').set('Cookie', cookie).expect(204);
    await request(app).get('/api/items').set('Cookie', cookie).expect(401);
  });
});
