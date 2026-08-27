import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { ObjectId } from 'mongodb';
import request from 'supertest';
import type { Express } from 'express';
import type * as DbModule from '../db.js';

/**
 * First run, end to end against a real mongod.
 *
 * The two claims worth proving are that the demo dataset arrives complete
 * enough for the dashboard to have something to say, and that removing it
 * removes exactly itself — an instance that has both the demo and real data
 * must lose one of the two, and the ledger must not be left pointing at items
 * that no longer exist.
 */
let replSet: MongoMemoryReplSet;
let app: Express;
let db: typeof DbModule;

const ADMIN = {
  email: 'admin@invintelx.org',
  name: 'Ada Operator',
  password: 'a-long-enough-password',
};

const MEMBER = {
  email: 'member@invintelx.org',
  name: 'Mo Member',
  password: 'a-long-enough-password',
};

/** Registers an account and returns the session cookie it was handed. */
async function registerAndSignIn(credentials: typeof ADMIN): Promise<string> {
  const response = await request(app).post('/api/auth/register').send(credentials).expect(201);
  const cookies = response.headers['set-cookie'];
  const header = Array.isArray(cookies) ? cookies[0] : cookies;
  return (header ?? '').split(';')[0] ?? '';
}

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });

  process.env.NODE_ENV = 'test';
  process.env.MONGODB_URI = replSet.getUri();
  process.env.MONGODB_DB = 'invintelx_onboarding_test';
  process.env.SESSION_SECRET = 'test-secret-that-is-definitely-long-enough';
  // Not what this file is about: the setup token has its own suite, and making
  // every registration here carry one would say nothing about onboarding.
  process.env.FIRST_ADMIN_SETUP = 'open';
  delete process.env.SETUP_TOKEN;

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
    db.users().deleteMany({}),
    db.sessions().deleteMany({}),
    db.items().deleteMany({}),
    db.locations().deleteMany({}),
    db.movements().deleteMany({}),
    db.stockLevels().deleteMany({}),
    db.suppliers().deleteMany({}),
    db.supplierItems().deleteMany({}),
    db.demoState().deleteMany({}),
  ]);
});

describe('GET /api/onboarding', () => {
  it('needs an account', async () => {
    await request(app).get('/api/onboarding').expect(401);
  });

  it('reports a brand new instance as empty with no demo data', async () => {
    const cookie = await registerAndSignIn(ADMIN);

    const response = await request(app).get('/api/onboarding').set('Cookie', cookie).expect(200);

    expect(response.body).toMatchObject({
      items: 0,
      locations: 0,
      movements: 0,
      empty: true,
      demo: null,
      canLoadDemo: true,
      canManageDemo: true,
    });
  });

  it('stops calling the instance empty once it holds one item of its own', async () => {
    const cookie = await registerAndSignIn(ADMIN);
    await request(app)
      .post('/api/items')
      .set('Cookie', cookie)
      .send({ sku: 'REAL-1', name: 'A real thing' })
      .expect(201);

    const response = await request(app).get('/api/onboarding').set('Cookie', cookie).expect(200);
    expect(response.body.empty).toBe(false);
    expect(response.body.items).toBe(1);
    expect(response.body.demo).toBeNull();
    expect(response.body.canLoadDemo).toBe(false);
  });

  it('tells a member that the demo dataset is not theirs to manage', async () => {
    await registerAndSignIn(ADMIN);
    const memberCookie = await registerAndSignIn(MEMBER);

    const response = await request(app)
      .get('/api/onboarding')
      .set('Cookie', memberCookie)
      .expect(200);
    expect(response.body.canManageDemo).toBe(false);
  });
});

describe('POST /api/onboarding/demo', () => {
  it('fills an empty instance with a dataset the dashboard can rank', async () => {
    const cookie = await registerAndSignIn(ADMIN);

    const loaded = await request(app)
      .post('/api/onboarding/demo')
      .set('Cookie', cookie)
      .expect(201);

    expect(loaded.body.items).toBeGreaterThan(0);
    expect(loaded.body.movements).toBeGreaterThan(0);
    expect(loaded.body.locations).toBeGreaterThan(0);
    expect(loaded.body.suppliers).toBeGreaterThan(0);

    // Stock is projected from the ledger, not written, so a demo that loaded
    // without rebuilding would show every SKU as having nothing on the shelf.
    expect(await db.stockLevels().countDocuments({})).toBeGreaterThan(0);

    const dashboard = await request(app)
      .get('/api/analytics/dashboard')
      .set('Cookie', cookie)
      .expect(200);
    expect(dashboard.body.itemsConsidered).toBe(loaded.body.items);
    expect(dashboard.body.inventoryValueCents).toBeGreaterThan(0);
  });

  it('marks every document it wrote as demo, so the wipe can find them', async () => {
    const cookie = await registerAndSignIn(ADMIN);
    await request(app).post('/api/onboarding/demo').set('Cookie', cookie).expect(201);

    for (const collection of [db.items, db.locations, db.suppliers, db.supplierItems, db.movements]) {
      expect(await collection().countDocuments({ isDemo: { $ne: true } })).toBe(0);
    }
  });

  it('says who loaded it and when', async () => {
    const cookie = await registerAndSignIn(ADMIN);
    await request(app).post('/api/onboarding/demo').set('Cookie', cookie).expect(201);

    const state = await request(app).get('/api/onboarding').set('Cookie', cookie).expect(200);
    expect(state.body.empty).toBe(false);
    expect(state.body.demo.loadedBy).toBe(ADMIN.name);
    expect(Date.parse(state.body.demo.loadedAt)).not.toBeNaN();
    expect(state.body.demo.items).toBe(state.body.items);
  });

  it('refuses a second copy', async () => {
    const cookie = await registerAndSignIn(ADMIN);
    await request(app).post('/api/onboarding/demo').set('Cookie', cookie).expect(201);

    const again = await request(app).post('/api/onboarding/demo').set('Cookie', cookie).expect(409);
    expect(again.body.error.message).toMatch(/already loaded/i);
  });

  it('refuses to mix itself into an instance that has real items', async () => {
    const cookie = await registerAndSignIn(ADMIN);
    await request(app)
      .post('/api/items')
      .set('Cookie', cookie)
      .send({ sku: 'REAL-1', name: 'A real thing' })
      .expect(201);

    const refused = await request(app)
      .post('/api/onboarding/demo')
      .set('Cookie', cookie)
      .expect(409);
    expect(refused.body.error.message).toMatch(/already has items/i);
    expect(await db.items().countDocuments({})).toBe(1);
  });

  it('is not a member action', async () => {
    await registerAndSignIn(ADMIN);
    const memberCookie = await registerAndSignIn(MEMBER);

    await request(app).post('/api/onboarding/demo').set('Cookie', memberCookie).expect(403);
    expect(await db.items().countDocuments({})).toBe(0);
  });

  /*
   * The marker is written last, so a load that dies part way through leaves
   * demo rows and no record of them. Pressing the button again has to be the
   * way out of that: without the sweep it is a unique-index collision on the
   * first SKU it tries to insert twice, and the instance is stuck.
   */
  it('clears the wreckage of an interrupted load rather than colliding with it', async () => {
    const cookie = await registerAndSignIn(ADMIN);
    await request(app).post('/api/onboarding/demo').set('Cookie', cookie).expect(201);
    const wholeDataset = await db.items().countDocuments({});
    // What is left when the process dies between the first insert and the last.
    await db.demoState().deleteMany({});
    await db.movements().deleteMany({});

    const state = await request(app).get('/api/onboarding').set('Cookie', cookie).expect(200);
    expect(state.body.empty).toBe(false);
    expect(state.body.canLoadDemo).toBe(true);

    await request(app).post('/api/onboarding/demo').set('Cookie', cookie).expect(201);
    expect(await db.items().countDocuments({})).toBe(wholeDataset);
  });
});

describe('DELETE /api/onboarding/demo', () => {
  it('takes the whole dataset back out and leaves an empty instance', async () => {
    const cookie = await registerAndSignIn(ADMIN);
    await request(app).post('/api/onboarding/demo').set('Cookie', cookie).expect(201);

    const removed = await request(app)
      .delete('/api/onboarding/demo')
      .set('Cookie', cookie)
      .expect(200);
    expect(removed.body.items).toBeGreaterThan(0);

    for (const collection of [db.items, db.locations, db.suppliers, db.supplierItems, db.movements]) {
      expect(await collection().countDocuments({})).toBe(0);
    }
    // The projection is downstream of the ledger; a wipe that forgot to rebuild
    // would leave every bin still holding stock for items that no longer exist.
    expect(await db.stockLevels().countDocuments({})).toBe(0);

    const state = await request(app).get('/api/onboarding').set('Cookie', cookie).expect(200);
    expect(state.body).toMatchObject({ empty: true, demo: null });
  });

  it('takes movements posted against a demo item with it', async () => {
    const cookie = await registerAndSignIn(ADMIN);
    await request(app).post('/api/onboarding/demo').set('Cookie', cookie).expect(201);

    // What a person looking around does: issue a few units of a demo SKU. That
    // row is theirs, not the demo's, so nothing marks it — but it references an
    // item that is about to stop existing.
    const item = await db.items().findOne({ isDemo: true });
    const bin = await db.locations().findOne({ type: 'bin' });
    expect(item).not.toBeNull();
    expect(bin).not.toBeNull();
    await db.movements().insertOne({
      _id: new ObjectId(),
      itemId: item!._id,
      itemSku: item!.sku,
      itemName: item!.name,
      locationId: bin!._id,
      locationCode: bin!.code,
      quantity: -1,
      type: 'issue',
      reference: 'BY-HAND',
      note: '',
      groupId: null,
      reversesId: null,
      reason: null,
      occurredAt: new Date(),
      actorId: new ObjectId(),
      actorName: 'Ada Operator',
      createdAt: new Date(),
    });

    await request(app).delete('/api/onboarding/demo').set('Cookie', cookie).expect(200);
    expect(await db.movements().countDocuments({})).toBe(0);
  });

  it('leaves real data alone', async () => {
    const cookie = await registerAndSignIn(ADMIN);
    await request(app).post('/api/onboarding/demo').set('Cookie', cookie).expect(201);
    // Created after the demo, the way somebody who liked what they saw would.
    await request(app)
      .post('/api/items')
      .set('Cookie', cookie)
      .send({ sku: 'MINE-1', name: 'My own SKU' })
      .expect(201);

    await request(app).delete('/api/onboarding/demo').set('Cookie', cookie).expect(200);

    const survivors = await db.items().find({}).toArray();
    expect(survivors.map((doc) => doc.sku)).toEqual(['MINE-1']);
  });

  /*
   * The case the flag alone gets wrong. A new instance has no locations of its
   * own, so the only bin anybody can receive their first real SKU into belongs
   * to the demo. Deleting it because it is marked demo would leave that SKU's
   * stock at a location that no longer exists — real data broken by a wipe that
   * promised to leave real data alone.
   */
  it('keeps a demo location that real stock has come to rest in', async () => {
    const cookie = await registerAndSignIn(ADMIN);
    await request(app).post('/api/onboarding/demo').set('Cookie', cookie).expect(201);

    const created = await request(app)
      .post('/api/items')
      .set('Cookie', cookie)
      .send({ sku: 'MINE-1', name: 'My own SKU' })
      .expect(201);
    const bin = await db.locations().findOne({ type: 'bin' });
    expect(bin).not.toBeNull();
    await request(app)
      .post('/api/movements/receive')
      .set('Cookie', cookie)
      .send({ itemId: created.body.id, locationId: bin!._id.toHexString(), quantity: 12 })
      .expect(201);

    const removed = await request(app)
      .delete('/api/onboarding/demo')
      .set('Cookie', cookie)
      .expect(200);
    expect(removed.body.retainedLocations).toBe(1);

    // The location survives, and it is no longer demo: the user has adopted it.
    const survivor = await db.locations().findOne({ _id: bin!._id });
    expect(survivor).not.toBeNull();
    expect(survivor!.isDemo).toBeUndefined();

    // And their stock is still somewhere real.
    const levels = await db.stockLevels().find({}).toArray();
    expect(levels).toHaveLength(1);
    expect(levels[0]!.onHand).toBe(12);
    expect(levels[0]!.locationId).toEqual(bin!._id);
    expect(await db.locations().countDocuments({ _id: levels[0]!.locationId })).toBe(1);
  });

  it('keeps a demo supplier that a real supply line points at', async () => {
    const cookie = await registerAndSignIn(ADMIN);
    await request(app).post('/api/onboarding/demo').set('Cookie', cookie).expect(201);

    const created = await request(app)
      .post('/api/items')
      .set('Cookie', cookie)
      .send({ sku: 'MINE-1', name: 'My own SKU' })
      .expect(201);
    const supplier = await db.suppliers().findOne({ isDemo: true });
    expect(supplier).not.toBeNull();
    await db.supplierItems().insertOne({
      _id: new ObjectId(),
      supplierId: supplier!._id,
      itemId: new ObjectId(created.body.id as string),
      supplierSku: 'THEIRS-1',
      priceBreaks: [{ minQuantity: 1, unitPriceCents: 500 }],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const removed = await request(app)
      .delete('/api/onboarding/demo')
      .set('Cookie', cookie)
      .expect(200);
    expect(removed.body.retainedSuppliers).toBe(1);

    const survivor = await db.suppliers().findOne({ _id: supplier!._id });
    expect(survivor).not.toBeNull();
    expect(survivor!.isDemo).toBeUndefined();
    expect(await db.supplierItems().countDocuments({})).toBe(1);
  });

  it('keeps nothing back when the demo is all there is', async () => {
    const cookie = await registerAndSignIn(ADMIN);
    await request(app).post('/api/onboarding/demo').set('Cookie', cookie).expect(201);

    const removed = await request(app)
      .delete('/api/onboarding/demo')
      .set('Cookie', cookie)
      .expect(200);
    expect(removed.body).toMatchObject({ retainedLocations: 0, retainedSuppliers: 0 });
    expect(await db.locations().countDocuments({})).toBe(0);
    expect(await db.suppliers().countDocuments({})).toBe(0);
  });

  it('404s when there is no demo dataset to remove', async () => {
    const cookie = await registerAndSignIn(ADMIN);
    await request(app).delete('/api/onboarding/demo').set('Cookie', cookie).expect(404);
  });

  it('is not a member action', async () => {
    const adminCookie = await registerAndSignIn(ADMIN);
    const memberCookie = await registerAndSignIn(MEMBER);
    await request(app).post('/api/onboarding/demo').set('Cookie', adminCookie).expect(201);

    await request(app).delete('/api/onboarding/demo').set('Cookie', memberCookie).expect(403);
    expect(await db.items().countDocuments({})).toBeGreaterThan(0);
  });
});
