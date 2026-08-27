import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { ObjectId } from 'mongodb';
import request from 'supertest';
import type { Express } from 'express';
import type * as DbModule from '../db.js';

/**
 * Integration tests against a real mongod, for the two reports INVX-31 adds.
 *
 * Both are aggregations over the ledger, and what makes them worth trusting is
 * that they agree with the movements actually recorded. Only a real database
 * proves that; a mocked collection would agree with whatever the test asserted.
 *
 * The banding arithmetic itself is covered without a database in
 * services/abc.test.ts. What is tested here is the round trip: movements in,
 * bands and capital out.
 */
let replSet: MongoMemoryReplSet;
let app: Express;
let db: typeof DbModule;
let cookie: string;
let bin: string;

const CREDENTIALS = {
  email: 'reports@invintelx.org',
  name: 'Reports Tester',
  password: 'a-long-enough-password',
};

/** The report builders read the real clock, so fixtures are dated against it. */
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

/**
 * Backdate an item's creation.
 *
 * Staleness is measured from the last issue or, failing that, from creation —
 * and the API stamps creation as now. Nothing else can make a never-issued item
 * old enough to be dead.
 */
async function age(itemId: string, days: number): Promise<void> {
  await db
    .items()
    .updateOne({ _id: new ObjectId(itemId) }, { $set: { createdAt: new Date(daysAgo(days)) } });
}

/** Return type left inferred from supertest, as every other suite here does. */
async function abc(query = '') {
  const response = await request(app)
    .get(`/api/analytics/abc${query}`)
    .set('Cookie', cookie)
    .expect(200);
  return response.body;
}

async function deadStock(query = '') {
  const response = await request(app)
    .get(`/api/analytics/dead-stock${query}`)
    .set('Cookie', cookie)
    .expect(200);
  return response.body;
}

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });

  // env.ts parses at import time, so these have to be set before it loads.
  process.env.NODE_ENV = 'test';
  process.env.MONGODB_URI = replSet.getUri();
  process.env.MONGODB_DB = 'invintelx_reports_test';
  process.env.SESSION_SECRET = 'test-secret-that-is-definitely-long-enough';
  // These tests are about the reports, not about claiming an instance.
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
  bin = await makeBin('RPT-1');
});

describe('GET /api/analytics/abc', () => {
  it('needs a session', async () => {
    await request(app).get('/api/analytics/abc').expect(401);
  });

  it('answers an empty instance with zeroes rather than an error', async () => {
    const body = await abc();

    expect(body.itemsConsidered).toBe(0);
    expect(body.total).toBe(0);
    expect(body.rows).toEqual([]);
    expect(body.annualConsumptionValueCents).toBe(0);
    expect(body.bands.map((b: { band: string }) => b.band)).toEqual(['A', 'B', 'C']);
  });

  it('ranks by consumption value, so the expensive slow mover beats the cheap fast one', async () => {
    const cheap = await makeItem('CHEAP', { unitCostCents: 10 });
    const dear = await makeItem('DEAR', { unitCostCents: 5000 });
    await receive(cheap, 1000, daysAgo(30));
    await receive(dear, 100, daysAgo(30));
    await issue(cheap, 500, daysAgo(10));
    await issue(dear, 50, daysAgo(10));

    const body = await abc();

    expect(body.rows.map((r: { sku: string }) => r.sku)).toEqual(['DEAR', 'CHEAP']);
    expect(body.rows[0]).toMatchObject({ sku: 'DEAR', rank: 1, unitsIssued: 50, band: 'A' });
    expect(body.rows[1]).toMatchObject({ sku: 'CHEAP', rank: 2, unitsIssued: 500 });
  });

  it('annualises the window it was asked for', async () => {
    // 90 units issued inside a 90-day window is 365 units a year, at 100 cents.
    const id = await makeItem('ANN-1', { unitCostCents: 100 });
    await receive(id, 200, daysAgo(80));
    await issue(id, 90, daysAgo(10));

    const body = await abc('?windowDays=90');

    expect(body.windowDays).toBe(90);
    expect(body.rows[0].unitsIssued).toBe(90);
    expect(body.rows[0].annualUnits).toBeCloseTo(365, 6);
    expect(body.rows[0].annualConsumptionValueCents).toBe(36_500);
  });

  it('counts only issues, not receipts or transfers', async () => {
    // A receipt is stock arriving and a transfer is stock moving. Neither is
    // consumption, and counting either would inflate every band.
    const other = await makeBin('RPT-2');
    const id = await makeItem('MIX-1', { unitCostCents: 100 });
    await receive(id, 100, daysAgo(20));
    await request(app)
      .post('/api/movements/transfer')
      .set('Cookie', cookie)
      .send({ itemId: id, fromLocationId: bin, toLocationId: other, quantity: 40 })
      .expect(201);
    await issue(id, 10, daysAgo(5));

    expect((await abc()).rows[0].unitsIssued).toBe(10);
  });

  it('ignores issues from before the window', async () => {
    const id = await makeItem('OLD-1', { unitCostCents: 100 });
    await receive(id, 500, daysAgo(300));
    await issue(id, 400, daysAgo(200));
    await issue(id, 5, daysAgo(2));

    expect((await abc('?windowDays=30')).rows[0].unitsIssued).toBe(5);
  });

  it('classifies a SKU nobody has issued as C rather than dropping it', async () => {
    const busy = await makeItem('BUSY-1', { unitCostCents: 100 });
    const idle = await makeItem('IDLE-1', { unitCostCents: 9999 });
    await receive(busy, 100, daysAgo(30));
    await receive(idle, 100, daysAgo(30));
    await issue(busy, 50, daysAgo(10));

    const body = await abc();

    expect(body.itemsConsidered).toBe(2);
    // Expensive stock that nobody consumes is a C item however much it cost.
    expect(body.rows[1]).toMatchObject({
      sku: 'IDLE-1',
      band: 'C',
      unitsIssued: 0,
      annualConsumptionValueCents: 0,
    });
  });

  it('narrows to one band without changing what it counted', async () => {
    // 85 / 12 / 3 of the value: one SKU per band, clear of both cuts so the
    // banding is not testing the rounding of an annualised cent.
    for (const [sku, units] of [
      ['A-1', 85],
      ['B-1', 12],
      ['C-1', 3],
    ] as const) {
      const id = await makeItem(sku, { unitCostCents: 100 });
      await receive(id, 200, daysAgo(30));
      await issue(id, units, daysAgo(10));
    }

    const all = await abc();
    expect(all.rows.map((r: { sku: string; band: string }) => [r.sku, r.band])).toEqual([
      ['A-1', 'A'],
      ['B-1', 'B'],
      ['C-1', 'C'],
    ]);

    const onlyA = await abc('?band=A');
    expect(onlyA.rows.map((r: { sku: string }) => r.sku)).toEqual(['A-1']);
    expect(onlyA.total).toBe(1);
    // The filter narrows the rows, never the classification behind them.
    expect(onlyA.itemsConsidered).toBe(3);
    expect(onlyA.bands).toEqual(all.bands);
    expect(onlyA.annualConsumptionValueCents).toBe(all.annualConsumptionValueCents);
  });

  it('truncates to the limit while reporting the full count', async () => {
    for (const sku of ['L-1', 'L-2', 'L-3']) {
      const id = await makeItem(sku, { unitCostCents: 100 });
      await receive(id, 100, daysAgo(30));
      await issue(id, 10, daysAgo(10));
    }

    const body = await abc('?limit=2');

    expect(body.rows).toHaveLength(2);
    expect(body.total).toBe(3);
    expect(body.itemsConsidered).toBe(3);
  });

  it('excludes archived items from the classification', async () => {
    const live = await makeItem('LIVE-1', { unitCostCents: 100 });
    const gone = await makeItem('GONE-1', { unitCostCents: 9999 });
    await receive(live, 100, daysAgo(30));
    await receive(gone, 100, daysAgo(30));
    await issue(live, 10, daysAgo(5));
    await issue(gone, 10, daysAgo(5));
    await request(app).post(`/api/items/${gone}/archive`).set('Cookie', cookie).expect(200);

    const body = await abc();

    expect(body.itemsConsidered).toBe(1);
    expect(body.rows.map((r: { sku: string }) => r.sku)).toEqual(['LIVE-1']);
  });

  it('reports bands that account for every SKU and every cent', async () => {
    for (const [sku, units] of [
      ['A-1', 85],
      ['B-1', 12],
      ['C-1', 3],
    ] as const) {
      const id = await makeItem(sku, { unitCostCents: 100 });
      await receive(id, 200, daysAgo(30));
      await issue(id, units, daysAgo(10));
    }

    const body = await abc();
    const bands: { itemCount: number; annualConsumptionValueCents: number }[] = body.bands;

    expect(bands.reduce((sum, b) => sum + b.itemCount, 0)).toBe(3);
    expect(bands.reduce((sum, b) => sum + b.annualConsumptionValueCents, 0)).toBe(
      body.annualConsumptionValueCents,
    );
  });

  it('refuses a B cut that does not sit above the A cut', async () => {
    await request(app)
      .get('/api/analytics/abc?aPercent=90&bPercent=80')
      .set('Cookie', cookie)
      .expect(400);
  });

  it('rejects a window the maths cannot stand behind', async () => {
    await request(app).get('/api/analytics/abc?windowDays=1').set('Cookie', cookie).expect(400);
  });
});

describe('GET /api/analytics/dead-stock', () => {
  it('needs a session', async () => {
    await request(app).get('/api/analytics/dead-stock').expect(401);
  });

  it('answers an empty instance with zeroes rather than an error', async () => {
    const body = await deadStock();

    expect(body.itemsConsidered).toBe(0);
    expect(body.total).toBe(0);
    expect(body.valueCents).toBe(0);
    expect(body.rows).toEqual([]);
  });

  it('lists stock nobody has issued for a long time, valued at cost', async () => {
    const id = await makeItem('DEAD-1', { unitCostCents: 1000 });
    await receive(id, 100, daysAgo(200));
    await issue(id, 1, daysAgo(200));

    const body = await deadStock();

    expect(body.total).toBe(1);
    expect(body.valueCents).toBe(99_000);
    expect(body.rows[0]).toMatchObject({
      sku: 'DEAD-1',
      onHand: 99,
      valueOnHandCents: 99_000,
      neverIssued: false,
    });
    expect(body.rows[0].daysStale).toBeGreaterThanOrEqual(199);
  });

  it('ranks by the capital tied up, not by how long it has sat', async () => {
    const small = await makeItem('SMALL', { unitCostCents: 10 });
    const large = await makeItem('LARGE', { unitCostCents: 5000 });
    // SMALL is the staler of the two, and the cheaper. Money wins.
    await receive(small, 100, daysAgo(300));
    await receive(large, 100, daysAgo(150));
    await age(small, 300);
    await age(large, 150);

    const body = await deadStock();

    expect(body.rows.map((r: { sku: string }) => r.sku)).toEqual(['LARGE', 'SMALL']);
    expect(body.valueCents).toBe(100 * 5000 + 100 * 10);
  });

  it('leaves out a SKU with nothing on the shelf', async () => {
    // An empty shelf is not dead stock; there is no capital in it to free.
    const id = await makeItem('EMPTY-1', { unitCostCents: 1000 });
    await receive(id, 10, daysAgo(300));
    await issue(id, 10, daysAgo(250));

    expect((await deadStock()).total).toBe(0);
  });

  it('does not call a SKU dead just because it is new', async () => {
    const id = await makeItem('NEW-1', { unitCostCents: 1000 });
    await receive(id, 100);

    expect((await deadStock()).total).toBe(0);
  });

  it('calls an old SKU that has never been issued dead', async () => {
    const id = await makeItem('IDLE-1', { unitCostCents: 1000 });
    await receive(id, 100, daysAgo(200));
    await age(id, 200);

    const body = await deadStock();

    expect(body.total).toBe(1);
    expect(body.rows[0]).toMatchObject({ sku: 'IDLE-1', neverIssued: true, lastIssuedAt: null });
  });

  it('honours a shorter threshold', async () => {
    const id = await makeItem('SLOW-1', { unitCostCents: 1000 });
    await receive(id, 100, daysAgo(60));
    await issue(id, 1, daysAgo(40));

    expect((await deadStock()).total).toBe(0);
    expect((await deadStock('?deadStockDays=30')).total).toBe(1);
  });

  it('states the whole capital tied up even when the rows are truncated', async () => {
    // The headline number is why anyone opens this report. Paging must not
    // change it.
    for (const sku of ['D-1', 'D-2', 'D-3']) {
      const id = await makeItem(sku, { unitCostCents: 1000 });
      await receive(id, 10, daysAgo(200));
      await age(id, 200);
    }

    const body = await deadStock('?limit=1');

    expect(body.rows).toHaveLength(1);
    expect(body.total).toBe(3);
    expect(body.valueCents).toBe(3 * 10 * 1000);
  });

  it('excludes archived items', async () => {
    // Dead on every count except being live, so only the archive keeps it off.
    const gone = await makeItem('GONE-1', { unitCostCents: 1000 });
    await receive(gone, 100, daysAgo(200));
    await age(gone, 200);
    await request(app).post(`/api/items/${gone}/archive`).set('Cookie', cookie).expect(200);

    const body = await deadStock();

    expect(body.itemsConsidered).toBe(0);
    expect(body.total).toBe(0);
    expect(body.valueCents).toBe(0);
  });

  it('agrees with the dashboard about which SKUs are dead', async () => {
    // The dashboard shortlists what this report lists in full. Two definitions
    // of "dead" would be two screens contradicting each other.
    const id = await makeItem('BOTH-1', { unitCostCents: 1000 });
    await receive(id, 100, daysAgo(200));
    await issue(id, 1, daysAgo(200));

    const dashboard = await request(app)
      .get('/api/analytics/dashboard')
      .set('Cookie', cookie)
      .expect(200);
    const report = await deadStock();

    expect(report.total).toBe(dashboard.body.deadStock.total);
    expect(report.valueCents).toBe(dashboard.body.deadStock.valueCents);
    expect(report.rows[0].sku).toBe(dashboard.body.deadStock.rows[0].sku);
  });

  it('rejects a threshold the report cannot stand behind', async () => {
    await request(app)
      .get('/api/analytics/dead-stock?deadStockDays=1')
      .set('Cookie', cookie)
      .expect(400);
  });
});
