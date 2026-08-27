import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import request from 'supertest';
import type { Express } from 'express';
import type * as DbModule from '../db.js';

/**
 * Resolving one scanned code to one item.
 *
 * Against a real mongod for the same reason the rest of the item suite is: the
 * SKU uniqueness these tests lean on is the index's promise, not ours.
 */
let replSet: MongoMemoryReplSet;
let app: Express;
let db: typeof DbModule;

const CREDENTIALS = {
  email: 'scanner@invintelx.org',
  name: 'Scanner',
  password: 'a-long-enough-password',
};

async function signIn(): Promise<string> {
  const response = await request(app).post('/api/auth/register').send(CREDENTIALS).expect(201);
  const cookies = response.headers['set-cookie'];
  const header = Array.isArray(cookies) ? cookies[0] : cookies;
  if (!header) throw new Error('register did not set a session cookie');
  return header.split(';')[0] ?? '';
}

async function createItem(
  cookie: string,
  body: Record<string, unknown>,
): Promise<Record<string, string>> {
  const response = await request(app)
    .post('/api/items')
    .set('Cookie', cookie)
    .send(body)
    .expect(201);
  return response.body;
}

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });

  process.env.NODE_ENV = 'test';
  process.env.MONGODB_URI = replSet.getUri();
  process.env.MONGODB_DB = 'invintelx_lookup_test';
  process.env.SESSION_SECRET = 'test-secret-that-is-definitely-long-enough';
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

describe('GET /api/items/lookup', () => {
  it('resolves a barcode to its item', async () => {
    const cookie = await signIn();
    await createItem(cookie, { sku: 'bolt-m6-30', name: 'Hex bolt', barcode: '5012345678900' });

    const response = await request(app)
      .get('/api/items/lookup?code=5012345678900')
      .set('Cookie', cookie)
      .expect(200);

    expect(response.body.sku).toBe('BOLT-M6-30');
  });

  /*
   * A scanner reading a Code 39 label reports whatever is printed, and SKUs are
   * stored uppercased. Without folding the case, half the labels in a warehouse
   * would be unrecognised codes.
   */
  it('resolves a SKU whatever case the scanner reports it in', async () => {
    const cookie = await signIn();
    await createItem(cookie, { sku: 'BOLT-M6-30', name: 'Hex bolt' });

    const lower = await request(app)
      .get('/api/items/lookup?code=bolt-m6-30')
      .set('Cookie', cookie)
      .expect(200);
    expect(lower.body.sku).toBe('BOLT-M6-30');
  });

  /*
   * The whole reason this is not the `q` search. "BOLT" is a prefix of the SKU
   * and a word in the name, and both would come back from a substring match —
   * but nothing was scanned that says "BOLT", so the answer is nothing.
   */
  it('does not answer a partial code', async () => {
    const cookie = await signIn();
    await createItem(cookie, { sku: 'BOLT-M6-30', name: 'Hex bolt', barcode: '5012345678900' });

    await request(app).get('/api/items/lookup?code=BOLT').set('Cookie', cookie).expect(404);
    await request(app).get('/api/items/lookup?code=50123456789').set('Cookie', cookie).expect(404);
  });

  it('404s an unknown code, naming the code back', async () => {
    const cookie = await signIn();

    const response = await request(app)
      .get('/api/items/lookup?code=9999999999999')
      .set('Cookie', cookie)
      .expect(404);

    expect(response.body.error.message).toContain('9999999999999');
  });

  /*
   * An archived SKU is not "nothing". Coming back with the item lets the screen
   * say "that one is archived" rather than offering to create a second item
   * with a SKU the unique index will reject.
   */
  it('returns an archived item rather than pretending it does not exist', async () => {
    const cookie = await signIn();
    const item = await createItem(cookie, { sku: 'GONE-1', name: 'Discontinued' });
    await request(app).post(`/api/items/${item.id}/archive`).set('Cookie', cookie).expect(200);

    const response = await request(app)
      .get('/api/items/lookup?code=GONE-1')
      .set('Cookie', cookie)
      .expect(200);

    expect(response.body.status).toBe('archived');
  });

  /*
   * Barcodes carry no unique index — a supplier reusing a code across two items
   * is a real thing — so which one comes back has to be predictable.
   */
  it('prefers the active item when two share a barcode', async () => {
    const cookie = await signIn();
    const old = await createItem(cookie, { sku: 'OLD-1', name: 'Old', barcode: '5099999999999' });
    await request(app).post(`/api/items/${old.id}/archive`).set('Cookie', cookie).expect(200);
    await createItem(cookie, { sku: 'NEW-1', name: 'New', barcode: '5099999999999' });

    const response = await request(app)
      .get('/api/items/lookup?code=5099999999999')
      .set('Cookie', cookie)
      .expect(200);

    expect(response.body.sku).toBe('NEW-1');
  });

  it('needs a session', async () => {
    await request(app).get('/api/items/lookup?code=BOLT-M6-30').expect(401);
  });

  it('rejects an empty code rather than answering with the first item it finds', async () => {
    const cookie = await signIn();
    await createItem(cookie, { sku: 'BOLT-M6-30', name: 'Hex bolt' });

    await request(app).get('/api/items/lookup?code=').set('Cookie', cookie).expect(400);
  });
});
