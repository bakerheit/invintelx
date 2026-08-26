import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { ObjectId } from 'mongodb';
import request from 'supertest';
import type { Express } from 'express';
import type * as DbModule from '../db.js';

/**
 * Integration tests against a real mongod.
 *
 * The dashboard is four aggregations over the same catalogue, and what makes it
 * worth trusting is that the lists agree with each other and with the ledger.
 * Only a real database proves that; a mocked collection would agree with
 * whatever the test asserted.
 */
let replSet: MongoMemoryReplSet;
let app: Express;
let db: typeof DbModule;
let cookie: string;
let bin: string;

const CREDENTIALS = {
  email: 'dashboard@invintelx.org',
  name: 'Dashboard Tester',
  password: 'a-long-enough-password',
};

/** `buildDashboard` reads the real clock, so fixtures are dated against it. */
function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

async function signIn(): Promise<string> {
  const response = await request(app).post('/api/auth/register').send(CREDENTIALS).expect(201);
  const cookies = response.headers['set-cookie'];
  const header = Array.isArray(cookies) ? cookies[0] : cookies;
  if (!header) throw new Error('register did not set a session cookie');
  return header.split(';')[0] ?? '';
}

/** Site > zone > bin, since only a bin may hold stock. */
async function makeBin(code: string): Promise<string> {
  const site = await request(app)
    .post('/api/locations')
    .set('Cookie', cookie)
    .send({ code: `${code}-SITE`, name: 'Site', type: 'site' })
    .expect(201);
  const zone = await request(app)
    .post('/api/locations')
    .set('Cookie', cookie)
    .send({ code: `${code}-ZONE`, name: 'Zone', type: 'zone', parentId: site.body.id })
    .expect(201);
  const created = await request(app)
    .post('/api/locations')
    .set('Cookie', cookie)
    .send({ code, name: 'Bin', type: 'bin', parentId: zone.body.id })
    .expect(201);
  return created.body.id;
}

async function makeItem(sku: string, fields: Record<string, unknown> = {}): Promise<string> {
  const response = await request(app)
    .post('/api/items')
    .set('Cookie', cookie)
    .send({ sku, name: `Item ${sku}`, unitCostCents: 250, ...fields })
    .expect(201);
  return response.body.id;
}

async function receive(itemId: string, quantity: number, occurredAt?: string): Promise<void> {
  await request(app)
    .post('/api/movements/receive')
    .set('Cookie', cookie)
    .send({ itemId, locationId: bin, quantity, ...(occurredAt ? { occurredAt } : {}) })
    .expect(201);
}

async function issue(itemId: string, quantity: number, occurredAt?: string): Promise<void> {
  await request(app)
    .post('/api/movements/issue')
    .set('Cookie', cookie)
    .send({ itemId, locationId: bin, quantity, ...(occurredAt ? { occurredAt } : {}) })
    .expect(201);
}

/** Return type left inferred from supertest, as every other suite here does. */
async function dashboard(query = '') {
  const response = await request(app)
    .get(`/api/analytics/dashboard${query}`)
    .set('Cookie', cookie)
    .expect(200);
  return response.body;
}

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });

  // env.ts parses at import time, so these have to be set before it loads.
  process.env.NODE_ENV = 'test';
  process.env.MONGODB_URI = replSet.getUri();
  process.env.MONGODB_DB = 'invintelx_dashboard_test';
  process.env.SESSION_SECRET = 'test-secret-that-is-definitely-long-enough';
  // These tests are about the dashboard, not about claiming an instance.
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
    db.locations().deleteMany({}),
    db.movements().deleteMany({}),
    db.stockLevels().deleteMany({}),
    db.users().deleteMany({}),
    db.sessions().deleteMany({}),
  ]);
  cookie = await signIn();
  bin = await makeBin('DASH-1');
});

describe('GET /api/analytics/dashboard', () => {
  it('needs a session', async () => {
    await request(app).get('/api/analytics/dashboard').expect(401);
  });

  it('answers an empty instance with zeroes rather than an error', async () => {
    const body = await dashboard();

    expect(body.itemsConsidered).toBe(0);
    expect(body.stockouts).toEqual({ total: 0, rows: [] });
    expect(body.belowReorderPoint).toEqual({ total: 0, rows: [] });
    expect(body.deadStock).toEqual({ total: 0, valueCents: 0, rows: [] });
    expect(body.inventoryValueCents).toBe(0);
    expect(body.movementVolume.totalUnits).toBe(0);
  });

  it('lists a SKU with nothing on hand as a stockout', async () => {
    const id = await makeItem('OUT-1');
    await receive(id, 50, daysAgo(10));
    await issue(id, 50, daysAgo(5));

    const body = await dashboard();

    expect(body.stockouts.total).toBe(1);
    expect(body.stockouts.rows[0]).toMatchObject({ sku: 'OUT-1', onHand: 0 });
    // Never in both lists: a stockout is a worse problem with a different
    // remedy, and listing it twice would make the top two rows one SKU.
    expect(body.belowReorderPoint.total).toBe(0);
  });

  it('lists a SKU at its reorder point but still holding stock as low, not out', async () => {
    const id = await makeItem('LOW-1', { reorderPoint: 20 });
    await receive(id, 30, daysAgo(10));
    await issue(id, 20, daysAgo(5));

    const body = await dashboard();

    expect(body.stockouts.total).toBe(0);
    expect(body.belowReorderPoint.total).toBe(1);
    expect(body.belowReorderPoint.rows[0]).toMatchObject({
      sku: 'LOW-1',
      onHand: 10,
      currentReorderPoint: 20,
      belowReorderPoint: true,
    });
  });

  it('ranks stockouts by the value of demand going unmet each day', async () => {
    const cheap = await makeItem('CHEAP', { unitCostCents: 10 });
    const dear = await makeItem('DEAR', { unitCostCents: 5000 });
    await receive(cheap, 100, daysAgo(20));
    await issue(cheap, 100, daysAgo(10));
    await receive(dear, 20, daysAgo(20));
    await issue(dear, 20, daysAgo(10));

    const body = await dashboard();

    expect(body.stockouts.rows.map((r: { sku: string }) => r.sku)).toEqual(['DEAR', 'CHEAP']);
  });

  it('shortlists to the limit while reporting the full count', async () => {
    for (const sku of ['A-1', 'A-2', 'A-3']) {
      const id = await makeItem(sku);
      await receive(id, 10, daysAgo(10));
      await issue(id, 10, daysAgo(5));
    }

    const body = await dashboard('?limit=2');

    // Five rows and five problems must not look the same as five rows out of
    // fifty; the total is what tells them apart.
    expect(body.stockouts.rows).toHaveLength(2);
    expect(body.stockouts.total).toBe(3);
  });

  it('lists stock nobody has issued for a long time as dead, valued at cost', async () => {
    const id = await makeItem('DEAD-1', { unitCostCents: 1000 });
    await receive(id, 100, daysAgo(200));
    await issue(id, 1, daysAgo(200));

    const body = await dashboard();

    expect(body.deadStock.total).toBe(1);
    expect(body.deadStock.rows[0]).toMatchObject({
      sku: 'DEAD-1',
      onHand: 99,
      valueOnHandCents: 99_000,
      neverIssued: false,
    });
    expect(body.deadStock.rows[0].daysStale).toBeGreaterThanOrEqual(199);
    expect(body.deadStock.valueCents).toBe(99_000);
  });

  it('does not call a SKU dead just because it is new', async () => {
    // Created today, never issued. Measuring "never" as infinitely stale would
    // put every new SKU at the top of the list on its first day.
    const id = await makeItem('NEW-1', { unitCostCents: 1000 });
    await receive(id, 100);

    expect((await dashboard()).deadStock.total).toBe(0);
  });

  it('calls an old SKU that has never been issued dead', async () => {
    const id = await makeItem('IDLE-1', { unitCostCents: 1000 });
    await receive(id, 100, daysAgo(200));
    // The API stamps createdAt as now, so the age is set directly. Nothing else
    // can make an item old.
    await db
      .items()
      .updateOne({ _id: new ObjectId(id) }, { $set: { createdAt: new Date(daysAgo(200)) } });

    const body = await dashboard();

    expect(body.deadStock.total).toBe(1);
    expect(body.deadStock.rows[0]).toMatchObject({
      sku: 'IDLE-1',
      neverIssued: true,
      lastIssuedAt: null,
    });
  });

  it('leaves a recently issued SKU out of dead stock', async () => {
    const id = await makeItem('BUSY-1', { unitCostCents: 1000 });
    await receive(id, 100, daysAgo(200));
    await issue(id, 1, daysAgo(3));

    expect((await dashboard()).deadStock.total).toBe(0);
  });

  it('honours a shorter dead-stock threshold', async () => {
    const id = await makeItem('SLOW-1', { unitCostCents: 1000 });
    await receive(id, 100, daysAgo(60));
    await issue(id, 1, daysAgo(40));

    expect((await dashboard()).deadStock.total).toBe(0);
    expect((await dashboard('?deadStockDays=30')).deadStock.total).toBe(1);
  });

  it('totals inventory at cost across the active catalogue', async () => {
    const one = await makeItem('VAL-1', { unitCostCents: 250 });
    const two = await makeItem('VAL-2', { unitCostCents: 1000 });
    await receive(one, 40);
    await receive(two, 3);

    const body = await dashboard();

    expect(body.inventoryValueCents).toBe(40 * 250 + 3 * 1000);
    expect(body.itemsConsidered).toBe(2);
  });

  it('excludes archived items from every figure on the screen', async () => {
    const live = await makeItem('LIVE-1', { unitCostCents: 250 });
    const gone = await makeItem('GONE-1', { unitCostCents: 9999 });
    await receive(live, 10);
    await receive(gone, 10);
    await request(app).post(`/api/items/${gone}/archive`).set('Cookie', cookie).expect(200);

    const body = await dashboard();

    expect(body.itemsConsidered).toBe(1);
    expect(body.inventoryValueCents).toBe(2500);
  });

  it('counts a transfer once, not once per leg', async () => {
    // A transfer writes two rows for one physical move. Summing both would
    // report twice the units that actually shifted.
    const other = await makeBin('DASH-2');
    const id = await makeItem('MOVE-1');
    await receive(id, 10);
    await request(app)
      .post('/api/movements/transfer')
      .set('Cookie', cookie)
      .send({ itemId: id, fromLocationId: bin, toLocationId: other, quantity: 4 })
      .expect(201);

    expect((await dashboard()).movementVolume.totalUnits).toBe(14);
  });

  it('counts an issue as volume by magnitude, not as a negative', async () => {
    // This measures how busy the warehouse is, not whether stock went up.
    const id = await makeItem('VOL-1');
    await receive(id, 10, daysAgo(2));
    await issue(id, 4, daysAgo(1));

    const body = await dashboard();

    expect(body.movementVolume.totalUnits).toBe(14);
    expect(body.movementVolume.series).toHaveLength(2);
  });

  it('leaves movements older than the window out of the volume series', async () => {
    const id = await makeItem('OLD-1');
    await receive(id, 500, daysAgo(200));
    await receive(id, 7, daysAgo(1));

    expect((await dashboard()).movementVolume.totalUnits).toBe(7);
  });

  it('rejects a window the maths cannot stand behind', async () => {
    await request(app)
      .get('/api/analytics/dashboard?windowDays=1')
      .set('Cookie', cookie)
      .expect(400);
  });
});
