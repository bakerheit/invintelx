import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import request from 'supertest';
import type { Express } from 'express';
import { autoMapColumns, parseCsv, type ItemCsvMapping } from '@invintelx/shared';
import type * as DbModule from '../db.js';

/**
 * Import and export, against a real mongod.
 *
 * The parts that can be decided without a database are pinned down in
 * `packages/shared/src/itemCsv.test.ts`. What is left here is everything that
 * only a database can answer: that matching on SKU really does update rather
 * than duplicate, that a rejected file writes nothing at all, and that what
 * comes out of the export goes back in without changing anything.
 */
let replSet: MongoMemoryReplSet;
let app: Express;
let db: typeof DbModule;

const CREDENTIALS = {
  email: 'tester@invintelx.org',
  name: 'Tester',
  password: 'a-long-enough-password',
};

async function signIn(): Promise<string> {
  const response = await request(app).post('/api/auth/register').send(CREDENTIALS).expect(201);
  const cookies = response.headers['set-cookie'];
  const header = Array.isArray(cookies) ? cookies[0] : cookies;
  if (!header) throw new Error('register did not set a session cookie');
  return header.split(';')[0] ?? '';
}

/** The mapping the screen would have offered for this file, so tests state the CSV only. */
function mappingFor(csv: string): ItemCsvMapping {
  return autoMapColumns(parseCsv(csv)[0]?.fields ?? []);
}

function preview(cookie: string, csv: string, mapping?: ItemCsvMapping) {
  return request(app)
    .post('/api/items/import/preview')
    .set('Cookie', cookie)
    .send({ csv, mapping: mapping ?? mappingFor(csv) });
}

function commit(cookie: string, csv: string, mapping?: ItemCsvMapping) {
  return request(app)
    .post('/api/items/import')
    .set('Cookie', cookie)
    .send({ csv, mapping: mapping ?? mappingFor(csv) });
}

const TWO_ITEMS =
  'sku,name,category,unitCost,unitPrice,reorderPoint\r\n' +
  'BOLT-M6-30,Hex bolt M6 x 30mm,Fasteners,0.12,0.30,100\r\n' +
  'NUT-M6,Hex nut M6,Fasteners,0.04,0.10,200\r\n';

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });

  process.env.NODE_ENV = 'test';
  process.env.MONGODB_URI = replSet.getUri();
  process.env.MONGODB_DB = 'invintelx_csv_test';
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

describe('item import', () => {
  it('requires authentication, and a member to write', async () => {
    await request(app).post('/api/items/import/preview').send({ csv: 'sku\n', mapping: {} }).expect(401);

    const cookie = await signIn();
    await db.users().updateOne({}, { $set: { role: 'viewer' } });
    await preview(cookie, TWO_ITEMS).expect(403);
  });

  it('previews creates without writing anything', async () => {
    const cookie = await signIn();

    const response = await preview(cookie, TWO_ITEMS).expect(200);
    expect(response.body).toMatchObject({ totalRows: 2, created: 2, updated: 0, failed: 0 });

    expect(await db.items().countDocuments({})).toBe(0);
  });

  it('creates on the first import and updates on the second, matching on SKU', async () => {
    const cookie = await signIn();

    expect((await commit(cookie, TWO_ITEMS).expect(200)).body).toEqual({
      created: 2,
      updated: 0,
      unchanged: 0,
    });

    const repriced = TWO_ITEMS.replace('0.12,0.30', '0.15,0.35');
    expect((await commit(cookie, repriced).expect(200)).body).toEqual({
      created: 0,
      updated: 1,
      unchanged: 1,
    });

    // Two imports of the same two SKUs, still two items - not four.
    expect(await db.items().countDocuments({})).toBe(2);
    const bolt = await db.items().findOne({ sku: 'BOLT-M6-30' });
    expect(bolt?.unitCostCents).toBe(15);
    expect(bolt?.unitPriceCents).toBe(35);
  });

  it('leaves an unchanged row entirely alone, timestamp included', async () => {
    const cookie = await signIn();
    await commit(cookie, TWO_ITEMS).expect(200);
    const before = await db.items().findOne({ sku: 'NUT-M6' });

    expect((await commit(cookie, TWO_ITEMS).expect(200)).body).toEqual({
      created: 0,
      updated: 0,
      unchanged: 2,
    });

    const after = await db.items().findOne({ sku: 'NUT-M6' });
    expect(after?.updatedAt).toEqual(before?.updatedAt);
  });

  it('rejects the whole file on a parse error and names the line', async () => {
    const cookie = await signIn();

    const response = await preview(
      cookie,
      'sku,name\r\nBOLT-M6-30,"never closed\r\nNUT-M6,Hex nut M6\r\n',
    ).expect(400);

    expect(response.body.error.fields.csv).toContain('Line 2');
    expect(await db.items().countDocuments({})).toBe(0);
  });

  it('reports per-row failures with line numbers and imports none of the file', async () => {
    const cookie = await signIn();

    const csv =
      'sku,name,unitCost\r\n' +
      'BOLT-M6-30,Hex bolt M6 x 30mm,0.12\r\n' +
      'WASH M6,Not a SKU,0.05\r\n' +
      'PIN-M6,Split pin,twelve pounds\r\n';

    const previewed = await preview(cookie, csv).expect(200);
    expect(previewed.body).toMatchObject({ totalRows: 3, created: 1, failed: 2 });
    expect(previewed.body.rows.filter((row: { action: string }) => row.action === 'error')).toEqual([
      expect.objectContaining({ line: 3 }),
      expect.objectContaining({ line: 4 }),
    ]);

    const rejected = await commit(cookie, csv).expect(400);
    expect(rejected.body.error.fields).toMatchObject({ 'line 3': expect.any(String) });

    // The one good row is not a consolation prize; the user fixes the file and retries.
    expect(await db.items().countDocuments({})).toBe(0);
  });

  it('refuses a file with no SKU column, since SKU is what it matches on', async () => {
    const cookie = await signIn();
    await preview(cookie, 'name,unitCost\r\nHex nut M6,0.04\r\n', { name: 0 }).expect(400);
  });

  it('honours a mapping that disagrees with the header names', async () => {
    const cookie = await signIn();

    // Deliberately misleading headers: only the mapping says what is what.
    const csv = 'alpha,beta\r\nBOLT-M6-30,Hex bolt M6 x 30mm\r\n';
    await commit(cookie, csv, { sku: 0, name: 1 }).expect(200);

    expect(await db.items().findOne({ sku: 'BOLT-M6-30' })).toMatchObject({
      name: 'Hex bolt M6 x 30mm',
    });
  });

  it('updates an archived item rather than colliding with it on the unique index', async () => {
    const cookie = await signIn();
    const created = await request(app)
      .post('/api/items')
      .set('Cookie', cookie)
      .send({ sku: 'BOLT-M6-30', name: 'Hex bolt M6 x 30mm' })
      .expect(201);
    await request(app)
      .post(`/api/items/${created.body.id}/archive`)
      .set('Cookie', cookie)
      .expect(200);

    const response = await commit(cookie, 'sku,name\r\nBOLT-M6-30,Renamed bolt\r\n').expect(200);
    expect(response.body).toEqual({ created: 0, updated: 1, unchanged: 0 });

    const bolt = await db.items().findOne({ sku: 'BOLT-M6-30' });
    // Still archived: the file said nothing about status, so nothing changed it.
    expect(bolt?.status).toBe('archived');
    expect(bolt?.name).toBe('Renamed bolt');
  });

  it('imports a file bigger than the general 1mb body limit', async () => {
    const cookie = await signIn();

    // Four thousand SKUs, which is the number in the ticket, padded with the
    // kind of description a real catalogue carries.
    const rows = Array.from(
      { length: 4000 },
      (_, index) => `SKU-${index},Item ${index},${'x'.repeat(300)}\r\n`,
    );
    const csv = `sku,name,description\r\n${rows.join('')}`;
    expect(csv.length).toBeGreaterThan(1_000_000);

    const response = await commit(cookie, csv).expect(200);
    expect(response.body.created).toBe(4000);
    expect(await db.items().countDocuments({})).toBe(4000);
  }, 60_000);
});

describe('item export', () => {
  it('sends a CSV attachment of the filtered rows, sorted by SKU', async () => {
    const cookie = await signIn();
    await commit(cookie, TWO_ITEMS).expect(200);

    const response = await request(app)
      .get('/api/items/export.csv')
      .set('Cookie', cookie)
      .expect(200);

    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.headers['content-disposition']).toContain('attachment');

    const records = parseCsv(response.text);
    expect(records[0]?.fields.slice(0, 3)).toEqual(['sku', 'name', 'description']);
    expect(records.slice(1).map((record) => record.fields[0])).toEqual(['BOLT-M6-30', 'NUT-M6']);
  });

  it('honours the same filters as the list, archived included', async () => {
    const cookie = await signIn();
    await commit(cookie, TWO_ITEMS).expect(200);
    const nut = await db.items().findOne({ sku: 'NUT-M6' });
    await request(app).post(`/api/items/${nut?._id.toHexString()}/archive`).set('Cookie', cookie);

    const active = await request(app)
      .get('/api/items/export.csv')
      .set('Cookie', cookie)
      .expect(200);
    expect(parseCsv(active.text)).toHaveLength(2);

    const archived = await request(app)
      .get('/api/items/export.csv?status=archived')
      .set('Cookie', cookie)
      .expect(200);
    expect(parseCsv(archived.text).slice(1).map((record) => record.fields[0])).toEqual(['NUT-M6']);

    const searched = await request(app)
      .get('/api/items/export.csv?q=BOLT')
      .set('Cookie', cookie)
      .expect(200);
    expect(parseCsv(searched.text)).toHaveLength(2);
  });

  it('round-trips: importing an untouched export changes nothing', async () => {
    const cookie = await signIn();
    await commit(
      cookie,
      'sku,name,description,unitCost\r\n' +
        'BOLT-M6-30,"Hex bolt, M6 x 30mm","Says 3"" on the box",0.12\r\n' +
        'NUT-M6,Hex nut M6,,0.04\r\n',
    ).expect(200);

    const exported = await request(app)
      .get('/api/items/export.csv')
      .set('Cookie', cookie)
      .expect(200);

    const response = await commit(cookie, exported.text).expect(200);
    expect(response.body).toEqual({ created: 0, updated: 0, unchanged: 2 });
  });

  it('round-trips the attribute columns too', async () => {
    const cookie = await signIn();
    await commit(cookie, 'sku,name,attr:Grade\r\nBOLT-M6-30,Hex bolt,8.8\r\n').expect(200);

    const exported = await request(app)
      .get('/api/items/export.csv')
      .set('Cookie', cookie)
      .expect(200);
    expect(parseCsv(exported.text)[0]?.fields).toContain('attr:Grade');

    expect((await commit(cookie, exported.text).expect(200)).body).toEqual({
      created: 0,
      updated: 0,
      unchanged: 1,
    });
  });
});
