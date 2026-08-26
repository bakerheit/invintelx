import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import request from 'supertest';
import type { Express } from 'express';
import type * as DbModule from '../db.js';

let replSet: MongoMemoryReplSet;
let app: Express;
let db: typeof DbModule;
let cookie: string;

const CREDENTIALS = {
  email: 'ledger@invintelx.org',
  name: 'Ledger Tester',
  password: 'a-long-enough-password',
};

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
  const bin = await request(app)
    .post('/api/locations')
    .set('Cookie', cookie)
    .send({ code, name: 'Bin', type: 'bin', parentId: zone.body.id })
    .expect(201);
  return bin.body.id;
}

async function makeItem(sku: string): Promise<string> {
  const response = await request(app)
    .post('/api/items')
    .set('Cookie', cookie)
    .send({ sku, name: `Item ${sku}` })
    .expect(201);
  return response.body.id;
}

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });

  process.env.NODE_ENV = 'test';
  process.env.MONGODB_URI = replSet.getUri();
  process.env.MONGODB_DB = 'invintelx_ledger_test';
  process.env.SESSION_SECRET = 'test-secret-that-is-definitely-long-enough';

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
});

describe('location hierarchy', () => {
  it('refuses a zone with no parent site', async () => {
    const response = await request(app)
      .post('/api/locations')
      .set('Cookie', cookie)
      .send({ code: 'ORPHAN', name: 'Orphan zone', type: 'zone' })
      .expect(400);
    expect(response.body.error.fields.parentId).toBeDefined();
  });

  it('refuses a bin parented to a site rather than a zone', async () => {
    const site = await request(app)
      .post('/api/locations')
      .set('Cookie', cookie)
      .send({ code: 'S1', name: 'Site', type: 'site' })
      .expect(201);

    await request(app)
      .post('/api/locations')
      .set('Cookie', cookie)
      .send({ code: 'B1', name: 'Bin', type: 'bin', parentId: site.body.id })
      .expect(400);
  });

  it('refuses a site given a parent', async () => {
    const site = await request(app)
      .post('/api/locations')
      .set('Cookie', cookie)
      .send({ code: 'S1', name: 'Site', type: 'site' })
      .expect(201);

    await request(app)
      .post('/api/locations')
      .set('Cookie', cookie)
      .send({ code: 'S2', name: 'Second site', type: 'site', parentId: site.body.id })
      .expect(400);
  });

  it('builds a materialised path so a subtree is one query', async () => {
    const binId = await makeBin('A-01');
    const bin = await request(app).get(`/api/locations/${binId}`).set('Cookie', cookie).expect(200);

    expect(bin.body.path).toHaveLength(3);
    expect(bin.body.path[2]).toBe(binId);
    expect(bin.body.pathLabel).toBe('A-01-SITE / A-01-ZONE / A-01');

    const siteId = bin.body.path[0];
    const subtree = await request(app)
      .get(`/api/locations?under=${siteId}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(subtree.body.total).toBe(3);
  });
});

describe('stock ledger', () => {
  it('a receipt adds and an issue removes', async () => {
    const [itemId, binId] = [await makeItem('LEDGER-1'), await makeBin('L-01')];

    const receipt = await request(app)
      .post('/api/movements/receive')
      .set('Cookie', cookie)
      .send({ itemId, locationId: binId, quantity: 100 })
      .expect(201);
    expect(receipt.body.balanceAfter).toBe(100);

    const issue = await request(app)
      .post('/api/movements/issue')
      .set('Cookie', cookie)
      .send({ itemId, locationId: binId, quantity: 30 })
      .expect(201);
    expect(issue.body.balanceAfter).toBe(70);
    // An issue is stored as a negative movement, not a positive with a flag.
    expect(issue.body.movement.quantity).toBe(-30);

    const stock = await request(app)
      .get(`/api/movements/stock/${itemId}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(stock.body.totalOnHand).toBe(70);
  });

  it('refuses to hold stock anywhere but a bin', async () => {
    const itemId = await makeItem('LEDGER-2');
    const site = await request(app)
      .post('/api/locations')
      .set('Cookie', cookie)
      .send({ code: 'S9', name: 'Site', type: 'site' })
      .expect(201);

    const response = await request(app)
      .post('/api/movements/receive')
      .set('Cookie', cookie)
      .send({ itemId, locationId: site.body.id, quantity: 5 })
      .expect(400);
    expect(response.body.error.fields.locationId).toBeDefined();
  });

  it('refuses movements against an archived item', async () => {
    const [itemId, binId] = [await makeItem('LEDGER-3'), await makeBin('L-03')];
    await request(app).post(`/api/items/${itemId}/archive`).set('Cookie', cookie).expect(200);

    await request(app)
      .post('/api/movements/receive')
      .set('Cookie', cookie)
      .send({ itemId, locationId: binId, quantity: 5 })
      .expect(400);
  });

  it('rejects a zero-quantity movement, which would record nothing', async () => {
    const [itemId, binId] = [await makeItem('LEDGER-4'), await makeBin('L-04')];
    await request(app)
      .post('/api/movements/receive')
      .set('Cookie', cookie)
      .send({ itemId, locationId: binId, quantity: 0 })
      .expect(400);
  });

  it('keeps stock separate per location', async () => {
    const itemId = await makeItem('LEDGER-5');
    const [binA, binB] = [await makeBin('L-05A'), await makeBin('L-05B')];

    await request(app)
      .post('/api/movements/receive')
      .set('Cookie', cookie)
      .send({ itemId, locationId: binA, quantity: 10 })
      .expect(201);
    await request(app)
      .post('/api/movements/receive')
      .set('Cookie', cookie)
      .send({ itemId, locationId: binB, quantity: 25 })
      .expect(201);

    const stock = await request(app)
      .get(`/api/movements/stock/${itemId}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(stock.body.totalOnHand).toBe(35);
    expect(stock.body.byLocation).toHaveLength(2);
  });

  it('allows on-hand to go negative rather than silently losing the movement', async () => {
    const [itemId, binId] = [await makeItem('LEDGER-6'), await makeBin('L-06')];

    // Stock left the building before the paperwork caught up. Refusing this
    // would mean it never gets recorded, which is worse than a visible negative.
    const issue = await request(app)
      .post('/api/movements/issue')
      .set('Cookie', cookie)
      .send({ itemId, locationId: binId, quantity: 4 })
      .expect(201);
    expect(issue.body.balanceAfter).toBe(-4);
  });

  it('exposes no way to update or delete a movement', async () => {
    const [itemId, binId] = [await makeItem('LEDGER-7'), await makeBin('L-07')];
    const receipt = await request(app)
      .post('/api/movements/receive')
      .set('Cookie', cookie)
      .send({ itemId, locationId: binId, quantity: 10 })
      .expect(201);

    const id = receipt.body.movement.id;
    await request(app).patch(`/api/movements/${id}`).set('Cookie', cookie).send({ quantity: 1 }).expect(404);
    await request(app).delete(`/api/movements/${id}`).set('Cookie', cookie).expect(404);
  });
});

describe('projection is verifiable', () => {
  it('rebuilding from the ledger reproduces the projection exactly', async () => {
    const itemId = await makeItem('REBUILD-1');
    const [binA, binB] = [await makeBin('R-01A'), await makeBin('R-01B')];

    for (const [location, qty] of [
      [binA, 50],
      [binB, 20],
      [binA, 15],
    ] as const) {
      await request(app)
        .post('/api/movements/receive')
        .set('Cookie', cookie)
        .send({ itemId, locationId: location, quantity: qty })
        .expect(201);
    }
    await request(app)
      .post('/api/movements/issue')
      .set('Cookie', cookie)
      .send({ itemId, locationId: binA, quantity: 25 })
      .expect(201);

    const before = await db.stockLevels().find({}).sort({ locationCode: 1 }).toArray();

    // Corrupt the projection, then prove the ledger can restore it. This is the
    // whole argument for event sourcing: on-hand is derivable, not authoritative.
    await db.stockLevels().updateMany({}, { $set: { onHand: 999_999 } });
    const result = await db.rebuildStockLevels();

    const after = await db.stockLevels().find({}).sort({ locationCode: 1 }).toArray();
    expect(result.movements).toBe(4);
    expect(after.map((l) => l.onHand)).toEqual(before.map((l) => l.onHand));
    expect(after.find((l) => l.locationCode === 'R-01A')?.onHand).toBe(40);
    expect(after.find((l) => l.locationCode === 'R-01B')?.onHand).toBe(20);
  });
});

describe('movement history', () => {
  it('reports the running balance after each movement, newest first', async () => {
    const [itemId, binId] = [await makeItem('HIST-1'), await makeBin('H-01')];

    for (const qty of [100, 50]) {
      await request(app)
        .post('/api/movements/receive')
        .set('Cookie', cookie)
        .send({ itemId, locationId: binId, quantity: qty })
        .expect(201);
    }
    await request(app)
      .post('/api/movements/issue')
      .set('Cookie', cookie)
      .send({ itemId, locationId: binId, quantity: 30 })
      .expect(201);

    const history = await request(app)
      .get(`/api/movements/history/${itemId}`)
      .set('Cookie', cookie)
      .expect(200);

    expect(history.body.total).toBe(3);
    // Newest first: 100 -> 150 -> 120.
    expect(history.body.data.map((m: { balanceAfter: number }) => m.balanceAfter)).toEqual([
      120, 150, 100,
    ]);
  });

  it('keeps the running balance correct across a page boundary', async () => {
    const [itemId, binId] = [await makeItem('HIST-2'), await makeBin('H-02')];
    for (let i = 0; i < 5; i += 1) {
      await request(app)
        .post('/api/movements/receive')
        .set('Cookie', cookie)
        .send({ itemId, locationId: binId, quantity: 10 })
        .expect(201);
    }

    const page1 = await request(app)
      .get(`/api/movements/history/${itemId}?pageSize=2&page=1`)
      .set('Cookie', cookie)
      .expect(200);
    const page2 = await request(app)
      .get(`/api/movements/history/${itemId}?pageSize=2&page=2`)
      .set('Cookie', cookie)
      .expect(200);

    expect(page1.body.data.map((m: { balanceAfter: number }) => m.balanceAfter)).toEqual([50, 40]);
    // Page 2 continues the sequence rather than restarting from the top.
    expect(page2.body.data.map((m: { balanceAfter: number }) => m.balanceAfter)).toEqual([30, 20]);
  });
});
