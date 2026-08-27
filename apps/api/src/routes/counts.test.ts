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
  email: 'counts@invintelx.org',
  name: 'Count Tester',
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

async function receive(itemId: string, locationId: string, quantity: number): Promise<void> {
  await request(app)
    .post('/api/movements/receive')
    .set('Cookie', cookie)
    .send({ itemId, locationId, quantity })
    .expect(201);
}

/** Returns the supertest request itself, so callers keep `.expect(...)`. */
function openSheet(body: Record<string, unknown>) {
  return request(app).post('/api/counts').set('Cookie', cookie).send(body);
}

interface SheetLine {
  id: string;
  itemSku: string;
  expectedQuantity: number;
  countedQuantity: number | null;
  variance: number | null;
  postedMovementId: string | null;
  postedQuantity: number | null;
  countedByName: string;
  countedAt: string | null;
}

function lineFor(sheet: { lines: SheetLine[] }, sku: string): SheetLine {
  const line = sheet.lines.find((l) => l.itemSku === sku);
  if (!line) throw new Error(`no line for ${sku}`);
  return line;
}

function count(sheetId: string, lineId: string, countedQuantity: number | null) {
  return request(app)
    .patch(`/api/counts/${sheetId}/lines/${lineId}`)
    .set('Cookie', cookie)
    .send({ countedQuantity });
}

async function onHandAt(itemId: string, locationCode: string): Promise<number> {
  const response = await request(app)
    .get(`/api/movements/stock/${itemId}`)
    .set('Cookie', cookie)
    .expect(200);
  const level = response.body.byLocation.find(
    (l: { locationCode: string }) => l.locationCode === locationCode,
  );
  return level?.onHand ?? 0;
}

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });

  process.env.NODE_ENV = 'test';
  process.env.MONGODB_URI = replSet.getUri();
  process.env.MONGODB_DB = 'invintelx_counts_test';
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
    db.locations().deleteMany({}),
    db.movements().deleteMany({}),
    db.stockLevels().deleteMany({}),
    db.countSheets().deleteMany({}),
    db.users().deleteMany({}),
    db.sessions().deleteMany({}),
  ]);
  cookie = await signIn();
});

describe('opening a sheet', () => {
  it('takes every item the books place in the bin', async () => {
    const bin = await makeBin('C-01');
    const bolt = await makeItem('BOLT-1');
    const nut = await makeItem('NUT-1');
    await receive(bolt, bin, 40);
    await receive(nut, bin, 7);

    const sheet = await openSheet({ locationId: bin }).expect(201);

    expect(sheet.body.scope).toBe('location');
    expect(sheet.body.status).toBe('open');
    expect(sheet.body.lines).toHaveLength(2);
    expect(lineFor(sheet.body, 'BOLT-1').expectedQuantity).toBe(40);
    expect(lineFor(sheet.body, 'NUT-1').expectedQuantity).toBe(7);
  });

  it('lists lines in SKU order, which is the order somebody walks a shelf', async () => {
    const bin = await makeBin('C-02');
    for (const sku of ['ZINC-9', 'ALLOY-2', 'MID-5']) {
      await receive(await makeItem(sku), bin, 1);
    }

    const sheet = await openSheet({ locationId: bin }).expect(201);
    expect(sheet.body.lines.map((l: SheetLine) => l.itemSku)).toEqual([
      'ALLOY-2',
      'MID-5',
      'ZINC-9',
    ]);
  });

  it('starts every line uncounted rather than at zero', async () => {
    const bin = await makeBin('C-03');
    await receive(await makeItem('SEAL-1'), bin, 5);

    const sheet = await openSheet({ locationId: bin }).expect(201);
    const line = lineFor(sheet.body, 'SEAL-1');
    expect(line.countedQuantity).toBeNull();
    expect(line.variance).toBeNull();
    expect(sheet.body.summary.countedCount).toBe(0);
    expect(sheet.body.summary.accuracy).toBeNull();
  });

  it('counts named items the books say are not there', async () => {
    // The whole reason to name items: a SKU the records show as absent is
    // exactly the one a lost pallet turns up under.
    const bin = await makeBin('C-04');
    const ghost = await makeItem('GHOST-1');

    const sheet = await openSheet({ locationId: bin, itemIds: [ghost] }).expect(201);
    expect(sheet.body.scope).toBe('items');
    expect(lineFor(sheet.body, 'GHOST-1').expectedQuantity).toBe(0);
  });

  it('refuses a bin the books place nothing in when no items are named', async () => {
    const bin = await makeBin('C-05');
    const response = await openSheet({ locationId: bin }).expect(400);
    expect(response.body.error.fields.locationId).toBeDefined();
  });

  it('refuses a zone, because only a bin holds stock', async () => {
    const site = await request(app)
      .post('/api/locations')
      .set('Cookie', cookie)
      .send({ code: 'Z-SITE', name: 'Site', type: 'site' })
      .expect(201);
    const zone = await request(app)
      .post('/api/locations')
      .set('Cookie', cookie)
      .send({ code: 'Z-ZONE', name: 'Zone', type: 'zone', parentId: site.body.id })
      .expect(201);

    const response = await openSheet({ locationId: zone.body.id, itemIds: [] }).expect(400);
    expect(response.body.error.fields.locationId).toBe('Pick a bin');
  });

  it('refuses to name an archived item, because its variance could never post', async () => {
    const bin = await makeBin('C-06');
    const itemId = await makeItem('OLD-1');
    await receive(itemId, bin, 3);
    await request(app).post(`/api/items/${itemId}/archive`).set('Cookie', cookie).expect(200);

    const response = await openSheet({ locationId: bin, itemIds: [itemId] }).expect(400);
    expect(response.body.error.message).toContain('OLD-1');
  });

  it('leaves an archived item off a whole-bin sheet rather than listing a line that cannot post', async () => {
    const bin = await makeBin('C-09');
    const live = await makeItem('LIVE-1');
    const dead = await makeItem('DEAD-9');
    await receive(live, bin, 5);
    await receive(dead, bin, 5);
    await request(app).post(`/api/items/${dead}/archive`).set('Cookie', cookie).expect(200);

    const sheet = await openSheet({ locationId: bin }).expect(201);
    expect(sheet.body.lines.map((l: SheetLine) => l.itemSku)).toEqual(['LIVE-1']);
  });

  it('gives the sheet a reference that can be read out loud', async () => {
    const bin = await makeBin('C-07');
    await receive(await makeItem('REF-1'), bin, 1);

    const sheet = await openSheet({ locationId: bin }).expect(201);
    expect(sheet.body.reference).toMatch(/^CC-[0-9A-F]{8}$/);
  });

  it('needs the member role', async () => {
    const bin = await makeBin('C-08');
    await receive(await makeItem('ROLE-1'), bin, 1);

    await db.users().updateMany({}, { $set: { role: 'viewer' } });
    await openSheet({ locationId: bin }).expect(403);
  });
});

describe('recording counts', () => {
  it('records a count and works out the variance', async () => {
    const bin = await makeBin('R-01');
    await receive(await makeItem('WIDGET-1'), bin, 12);
    const sheet = await openSheet({ locationId: bin }).expect(201);

    const updated = await count(sheet.body.id, lineFor(sheet.body, 'WIDGET-1').id, 9).expect(200);
    const line = lineFor(updated.body, 'WIDGET-1');
    expect(line.countedQuantity).toBe(9);
    expect(line.variance).toBe(-3);
    expect(line.countedByName).toBe(CREDENTIALS.name);
    expect(line.countedAt).not.toBeNull();
  });

  it('treats a counted zero as a count, not as nothing', async () => {
    const bin = await makeBin('R-02');
    await receive(await makeItem('EMPTY-1'), bin, 6);
    const sheet = await openSheet({ locationId: bin }).expect(201);

    const updated = await count(sheet.body.id, lineFor(sheet.body, 'EMPTY-1').id, 0).expect(200);
    expect(lineFor(updated.body, 'EMPTY-1').variance).toBe(-6);
    expect(updated.body.summary.countedCount).toBe(1);
  });

  it('clears a count back to uncounted with null', async () => {
    const bin = await makeBin('R-03');
    await receive(await makeItem('UNDO-1'), bin, 4);
    const sheet = await openSheet({ locationId: bin }).expect(201);
    const lineId = lineFor(sheet.body, 'UNDO-1').id;

    await count(sheet.body.id, lineId, 2).expect(200);
    const cleared = await count(sheet.body.id, lineId, null).expect(200);

    const line = lineFor(cleared.body, 'UNDO-1');
    expect(line.countedQuantity).toBeNull();
    expect(line.variance).toBeNull();
    expect(line.countedByName).toBe('');
    expect(cleared.body.summary.countedCount).toBe(0);
  });

  it('refuses a negative count', async () => {
    const bin = await makeBin('R-04');
    await receive(await makeItem('NEG-1'), bin, 4);
    const sheet = await openSheet({ locationId: bin }).expect(201);

    await count(sheet.body.id, lineFor(sheet.body, 'NEG-1').id, -1).expect(400);
  });

  it('does not move stock', async () => {
    const bin = await makeBin('R-05');
    const itemId = await makeItem('STILL-1');
    await receive(itemId, bin, 20);
    const sheet = await openSheet({ locationId: bin }).expect(201);

    await count(sheet.body.id, lineFor(sheet.body, 'STILL-1').id, 3).expect(200);

    expect(await onHandAt(itemId, 'R-05')).toBe(20);
    expect(await db.movements().countDocuments({ type: 'adjustment' })).toBe(0);
  });

  it('404s a line that is not on the sheet', async () => {
    const bin = await makeBin('R-06');
    await receive(await makeItem('MISS-1'), bin, 1);
    const sheet = await openSheet({ locationId: bin }).expect(201);

    await count(sheet.body.id, '0123456789abcdef01234567', 1).expect(404);
  });
});

describe('the variance report', () => {
  it('separates net from absolute, so offsetting errors are not hidden', async () => {
    const bin = await makeBin('V-01');
    const over = await makeItem('OVER-1');
    const short = await makeItem('SHORT-1');
    await receive(over, bin, 10);
    await receive(short, bin, 10);

    const sheet = await openSheet({ locationId: bin }).expect(201);
    await count(sheet.body.id, lineFor(sheet.body, 'OVER-1').id, 15).expect(200);
    const final = await count(sheet.body.id, lineFor(sheet.body, 'SHORT-1').id, 5).expect(200);

    expect(final.body.summary.netVariance).toBe(0);
    expect(final.body.summary.absVariance).toBe(10);
    expect(final.body.summary.overCount).toBe(1);
    expect(final.body.summary.shortCount).toBe(1);
    expect(final.body.summary.varianceCount).toBe(2);
  });

  it('measures accuracy against counted lines only', async () => {
    const bin = await makeBin('V-02');
    for (const sku of ['ACC-1', 'ACC-2', 'ACC-3']) await receive(await makeItem(sku), bin, 5);

    const sheet = await openSheet({ locationId: bin }).expect(201);
    await count(sheet.body.id, lineFor(sheet.body, 'ACC-1').id, 5).expect(200);
    const final = await count(sheet.body.id, lineFor(sheet.body, 'ACC-2').id, 4).expect(200);

    expect(final.body.summary.countedCount).toBe(2);
    expect(final.body.summary.uncountedCount).toBe(1);
    expect(final.body.summary.accuracy).toBeCloseTo(0.5);
  });
});

describe('accepting variances', () => {
  it('posts the difference as an adjustment and moves on-hand to the count', async () => {
    const bin = await makeBin('P-01');
    const itemId = await makeItem('POST-1');
    await receive(itemId, bin, 12);

    const sheet = await openSheet({ locationId: bin }).expect(201);
    const lineId = lineFor(sheet.body, 'POST-1').id;
    await count(sheet.body.id, lineId, 9).expect(200);

    const posted = await request(app)
      .post(`/api/counts/${sheet.body.id}/post`)
      .set('Cookie', cookie)
      .send({ lineIds: [lineId], note: 'Counted by Wendy' })
      .expect(201);

    expect(posted.body.movements).toHaveLength(1);
    const movement = posted.body.movements[0];
    expect(movement.type).toBe('adjustment');
    expect(movement.quantity).toBe(-3);
    expect(movement.reason).toBe('miscount');
    expect(movement.reference).toBe(sheet.body.reference);
    expect(movement.note).toBe('Counted by Wendy');
    expect(posted.body.balances).toEqual([9]);

    expect(await onHandAt(itemId, 'P-01')).toBe(9);
  });

  it('posts the variance rather than the count, so a later receipt survives', async () => {
    // Expected 10, counted 8 — two genuinely missing. A receipt of 5 lands
    // before the sheet is accepted. Setting on-hand to 8 would erase it; posting
    // the difference of -2 leaves 13, which is the only true answer.
    const bin = await makeBin('P-02');
    const itemId = await makeItem('LATE-1');
    await receive(itemId, bin, 10);

    const sheet = await openSheet({ locationId: bin }).expect(201);
    const lineId = lineFor(sheet.body, 'LATE-1').id;
    await count(sheet.body.id, lineId, 8).expect(200);

    await receive(itemId, bin, 5);

    await request(app)
      .post(`/api/counts/${sheet.body.id}/post`)
      .set('Cookie', cookie)
      .send({ lineIds: [lineId] })
      .expect(201);

    expect(await onHandAt(itemId, 'P-02')).toBe(13);
  });

  it('records which movement each accepted line produced', async () => {
    const bin = await makeBin('P-03');
    const itemId = await makeItem('TRACE-1');
    await receive(itemId, bin, 4);

    const sheet = await openSheet({ locationId: bin }).expect(201);
    const lineId = lineFor(sheet.body, 'TRACE-1').id;
    await count(sheet.body.id, lineId, 7).expect(200);

    const posted = await request(app)
      .post(`/api/counts/${sheet.body.id}/post`)
      .set('Cookie', cookie)
      .send({ lineIds: [lineId] })
      .expect(201);

    const line = lineFor(posted.body.sheet, 'TRACE-1');
    expect(line.postedQuantity).toBe(3);
    expect(line.postedMovementId).toBe(posted.body.movements[0].id);
  });

  it('writes nothing for a line that agrees', async () => {
    const bin = await makeBin('P-04');
    const itemId = await makeItem('AGREE-1');
    await receive(itemId, bin, 6);

    const sheet = await openSheet({ locationId: bin }).expect(201);
    const lineId = lineFor(sheet.body, 'AGREE-1').id;
    await count(sheet.body.id, lineId, 6).expect(200);

    const posted = await request(app)
      .post(`/api/counts/${sheet.body.id}/post`)
      .set('Cookie', cookie)
      .send({ lineIds: [lineId] })
      .expect(201);

    expect(posted.body.movements).toHaveLength(0);
    expect(posted.body.sheet.status).toBe('posted');
    expect(lineFor(posted.body.sheet, 'AGREE-1').postedMovementId).toBeNull();
    expect(await onHandAt(itemId, 'P-04')).toBe(6);
  });

  it('leaves a counted line alone when it is not accepted', async () => {
    const bin = await makeBin('P-05');
    const yes = await makeItem('YES-1');
    const no = await makeItem('NO-1');
    await receive(yes, bin, 10);
    await receive(no, bin, 10);

    const sheet = await openSheet({ locationId: bin }).expect(201);
    await count(sheet.body.id, lineFor(sheet.body, 'YES-1').id, 8).expect(200);
    await count(sheet.body.id, lineFor(sheet.body, 'NO-1').id, 8).expect(200);

    const posted = await request(app)
      .post(`/api/counts/${sheet.body.id}/post`)
      .set('Cookie', cookie)
      .send({ lineIds: [lineFor(sheet.body, 'YES-1').id] })
      .expect(201);

    expect(posted.body.movements).toHaveLength(1);
    expect(await onHandAt(yes, 'P-05')).toBe(8);
    expect(await onHandAt(no, 'P-05')).toBe(10);
    expect(lineFor(posted.body.sheet, 'NO-1').postedMovementId).toBeNull();
    // The count is still on the record even though nobody believed it.
    expect(lineFor(posted.body.sheet, 'NO-1').countedQuantity).toBe(8);
  });

  it('refuses to accept a line nobody counted', async () => {
    const bin = await makeBin('P-06');
    await receive(await makeItem('BLANK-1'), bin, 5);

    const sheet = await openSheet({ locationId: bin }).expect(201);
    const response = await request(app)
      .post(`/api/counts/${sheet.body.id}/post`)
      .set('Cookie', cookie)
      .send({ lineIds: [lineFor(sheet.body, 'BLANK-1').id] })
      .expect(400);

    expect(response.body.error.message).toContain('BLANK-1');
    expect(await db.movements().countDocuments({ type: 'adjustment' })).toBe(0);
  });

  it('refuses a post that accepts no lines at all', async () => {
    const bin = await makeBin('P-07');
    await receive(await makeItem('NONE-1'), bin, 5);
    const sheet = await openSheet({ locationId: bin }).expect(201);

    await request(app)
      .post(`/api/counts/${sheet.body.id}/post`)
      .set('Cookie', cookie)
      .send({ lineIds: [] })
      .expect(400);
  });

  it('writes nothing when one accepted line is uncounted, however many are fine', async () => {
    // All or nothing: a sheet that refuses halfway would leave some variances
    // on the ledger and the sheet still open, with no way to tell which.
    const bin = await makeBin('P-08');
    const good = await makeItem('GOOD-1');
    const blank = await makeItem('BLANK-2');
    await receive(good, bin, 10);
    await receive(blank, bin, 10);

    const sheet = await openSheet({ locationId: bin }).expect(201);
    await count(sheet.body.id, lineFor(sheet.body, 'GOOD-1').id, 3).expect(200);

    await request(app)
      .post(`/api/counts/${sheet.body.id}/post`)
      .set('Cookie', cookie)
      .send({ lineIds: sheet.body.lines.map((l: SheetLine) => l.id) })
      .expect(400);

    expect(await db.movements().countDocuments({ type: 'adjustment' })).toBe(0);
    expect(await onHandAt(good, 'P-08')).toBe(10);
    const still = await request(app)
      .get(`/api/counts/${sheet.body.id}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(still.body.status).toBe('open');
  });

  it('refuses a line id from another sheet', async () => {
    const bin = await makeBin('P-09');
    await receive(await makeItem('OTHER-1'), bin, 5);
    const first = await openSheet({ locationId: bin }).expect(201);
    const second = await openSheet({ locationId: bin }).expect(201);

    await request(app)
      .post(`/api/counts/${first.body.id}/post`)
      .set('Cookie', cookie)
      .send({ lineIds: [lineFor(second.body, 'OTHER-1').id] })
      .expect(400);
  });

  it('cannot post the same sheet twice', async () => {
    const bin = await makeBin('P-10');
    const itemId = await makeItem('TWICE-1');
    await receive(itemId, bin, 10);

    const sheet = await openSheet({ locationId: bin }).expect(201);
    const lineId = lineFor(sheet.body, 'TWICE-1').id;
    await count(sheet.body.id, lineId, 4).expect(200);

    await request(app)
      .post(`/api/counts/${sheet.body.id}/post`)
      .set('Cookie', cookie)
      .send({ lineIds: [lineId] })
      .expect(201);
    await request(app)
      .post(`/api/counts/${sheet.body.id}/post`)
      .set('Cookie', cookie)
      .send({ lineIds: [lineId] })
      .expect(409);

    expect(await db.movements().countDocuments({ type: 'adjustment' })).toBe(1);
    expect(await onHandAt(itemId, 'P-10')).toBe(4);
  });

  it('refuses to count against a posted sheet', async () => {
    const bin = await makeBin('P-11');
    await receive(await makeItem('SHUT-1'), bin, 5);

    const sheet = await openSheet({ locationId: bin }).expect(201);
    const lineId = lineFor(sheet.body, 'SHUT-1').id;
    await count(sheet.body.id, lineId, 5).expect(200);
    await request(app)
      .post(`/api/counts/${sheet.body.id}/post`)
      .set('Cookie', cookie)
      .send({ lineIds: [lineId] })
      .expect(201);

    await count(sheet.body.id, lineId, 2).expect(409);
  });

  it('accepts several variances in one act', async () => {
    const bin = await makeBin('P-12');
    const a = await makeItem('MANY-A');
    const b = await makeItem('MANY-B');
    const c = await makeItem('MANY-C');
    await receive(a, bin, 10);
    await receive(b, bin, 10);
    await receive(c, bin, 10);

    const sheet = await openSheet({ locationId: bin }).expect(201);
    await count(sheet.body.id, lineFor(sheet.body, 'MANY-A').id, 12).expect(200);
    await count(sheet.body.id, lineFor(sheet.body, 'MANY-B').id, 10).expect(200);
    const ready = await count(sheet.body.id, lineFor(sheet.body, 'MANY-C').id, 1).expect(200);

    const posted = await request(app)
      .post(`/api/counts/${sheet.body.id}/post`)
      .set('Cookie', cookie)
      .send({ lineIds: ready.body.lines.map((l: SheetLine) => l.id) })
      .expect(201);

    // Two movements: the agreeing line writes nothing.
    expect(posted.body.movements).toHaveLength(2);
    expect(await onHandAt(a, 'P-12')).toBe(12);
    expect(await onHandAt(b, 'P-12')).toBe(10);
    expect(await onHandAt(c, 'P-12')).toBe(1);
  });

  it('needs the member role', async () => {
    const bin = await makeBin('P-13');
    await receive(await makeItem('PERM-1'), bin, 5);
    const sheet = await openSheet({ locationId: bin }).expect(201);
    const lineId = lineFor(sheet.body, 'PERM-1').id;
    await count(sheet.body.id, lineId, 4).expect(200);

    await db.users().updateMany({}, { $set: { role: 'viewer' } });
    await request(app)
      .post(`/api/counts/${sheet.body.id}/post`)
      .set('Cookie', cookie)
      .send({ lineIds: [lineId] })
      .expect(403);
  });
});

describe('the ledger stays the source of truth', () => {
  it('rebuilding the projection reproduces the numbers a count produced', async () => {
    const bin = await makeBin('L-01');
    const itemId = await makeItem('REBUILD-1');
    await receive(itemId, bin, 30);

    const sheet = await openSheet({ locationId: bin }).expect(201);
    const lineId = lineFor(sheet.body, 'REBUILD-1').id;
    await count(sheet.body.id, lineId, 27).expect(200);
    await request(app)
      .post(`/api/counts/${sheet.body.id}/post`)
      .set('Cookie', cookie)
      .send({ lineIds: [lineId] })
      .expect(201);

    const before = await db.stockLevels().find({}).sort({ locationCode: 1 }).toArray();
    await db.stockLevels().updateMany({}, { $set: { onHand: -9999 } });
    await db.rebuildStockLevels();
    const after = await db.stockLevels().find({}).sort({ locationCode: 1 }).toArray();

    expect(after.map((l) => l.onHand)).toEqual(before.map((l) => l.onHand));
    expect(after[0]?.onHand).toBe(27);
  });

  it('leaves a count adjustment reversible like any other adjustment', async () => {
    const bin = await makeBin('L-02');
    const itemId = await makeItem('REV-1');
    await receive(itemId, bin, 10);

    const sheet = await openSheet({ locationId: bin }).expect(201);
    const lineId = lineFor(sheet.body, 'REV-1').id;
    await count(sheet.body.id, lineId, 6).expect(200);
    const posted = await request(app)
      .post(`/api/counts/${sheet.body.id}/post`)
      .set('Cookie', cookie)
      .send({ lineIds: [lineId] })
      .expect(201);

    await request(app)
      .post(`/api/movements/${posted.body.movements[0].id}/reverse`)
      .set('Cookie', cookie)
      .send({ note: 'The counter read the wrong label' })
      .expect(201);

    expect(await onHandAt(itemId, 'L-02')).toBe(10);
  });

  it('shows the count adjustment in the item history', async () => {
    const bin = await makeBin('L-03');
    const itemId = await makeItem('HIST-1');
    await receive(itemId, bin, 8);

    const sheet = await openSheet({ locationId: bin }).expect(201);
    const lineId = lineFor(sheet.body, 'HIST-1').id;
    await count(sheet.body.id, lineId, 5).expect(200);
    await request(app)
      .post(`/api/counts/${sheet.body.id}/post`)
      .set('Cookie', cookie)
      .send({ lineIds: [lineId] })
      .expect(201);

    const history = await request(app)
      .get(`/api/movements/history/${itemId}`)
      .set('Cookie', cookie)
      .expect(200);

    expect(history.body.data[0].type).toBe('adjustment');
    expect(history.body.data[0].reference).toBe(sheet.body.reference);
    expect(history.body.data[0].balanceAfter).toBe(5);
  });
});

describe('cancelling and listing', () => {
  it('cancels without writing anything', async () => {
    const bin = await makeBin('X-01');
    const itemId = await makeItem('CANCEL-1');
    await receive(itemId, bin, 10);

    const sheet = await openSheet({ locationId: bin }).expect(201);
    const lineId = lineFor(sheet.body, 'CANCEL-1').id;
    await count(sheet.body.id, lineId, 2).expect(200);

    const cancelled = await request(app)
      .post(`/api/counts/${sheet.body.id}/cancel`)
      .set('Cookie', cookie)
      .send({ note: 'Wrong aisle' })
      .expect(200);

    expect(cancelled.body.status).toBe('cancelled');
    // The count survives, because a count that was walked is evidence too.
    expect(lineFor(cancelled.body, 'CANCEL-1').countedQuantity).toBe(2);
    expect(await onHandAt(itemId, 'X-01')).toBe(10);
  });

  it('refuses to post a cancelled sheet', async () => {
    const bin = await makeBin('X-02');
    await receive(await makeItem('DEAD-1'), bin, 10);

    const sheet = await openSheet({ locationId: bin }).expect(201);
    const lineId = lineFor(sheet.body, 'DEAD-1').id;
    await count(sheet.body.id, lineId, 2).expect(200);
    await request(app)
      .post(`/api/counts/${sheet.body.id}/cancel`)
      .set('Cookie', cookie)
      .send({})
      .expect(200);

    await request(app)
      .post(`/api/counts/${sheet.body.id}/post`)
      .set('Cookie', cookie)
      .send({ lineIds: [lineId] })
      .expect(409);
  });

  it('lists sheets newest first, with their summary and without their lines', async () => {
    const bin = await makeBin('X-03');
    await receive(await makeItem('LIST-1'), bin, 10);
    const first = await openSheet({ locationId: bin }).expect(201);
    await count(first.body.id, lineFor(first.body, 'LIST-1').id, 7).expect(200);
    const second = await openSheet({ locationId: bin }).expect(201);

    const list = await request(app).get('/api/counts').set('Cookie', cookie).expect(200);

    expect(list.body.total).toBe(2);
    expect(list.body.data[0].id).toBe(second.body.id);
    expect(list.body.data[1].id).toBe(first.body.id);
    expect(list.body.data[1].summary.absVariance).toBe(3);
    expect(list.body.data[0].lines).toBeUndefined();
  });

  it('filters by status', async () => {
    const bin = await makeBin('X-04');
    await receive(await makeItem('FILT-1'), bin, 10);
    const open = await openSheet({ locationId: bin }).expect(201);
    const doomed = await openSheet({ locationId: bin }).expect(201);
    await request(app)
      .post(`/api/counts/${doomed.body.id}/cancel`)
      .set('Cookie', cookie)
      .send({})
      .expect(200);

    const list = await request(app)
      .get('/api/counts?status=open')
      .set('Cookie', cookie)
      .expect(200);

    expect(list.body.data.map((s: { id: string }) => s.id)).toEqual([open.body.id]);
  });

  it('404s an id that is not a sheet', async () => {
    await request(app)
      .get('/api/counts/0123456789abcdef01234567')
      .set('Cookie', cookie)
      .expect(404);
    await request(app).get('/api/counts/not-an-id').set('Cookie', cookie).expect(404);
  });

  it('needs a session', async () => {
    await request(app).get('/api/counts').expect(401);
  });
});
