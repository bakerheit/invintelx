import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import request from 'supertest';
import type { Express } from 'express';
import { autoMapColumns, parseCsv, type AuditEntry, type ItemCsvMapping } from '@invintelx/shared';
import type * as DbModule from '../db.js';

/**
 * Integration tests against a real mongod, for the same reason the item tests
 * are: the guarantee under examination is that the mutation and its record land
 * together in one transaction, and only a real replica set can be wrong about
 * that.
 */
let replSet: MongoMemoryReplSet;
let app: Express;
let db: typeof DbModule;

const ADMIN = {
  email: 'admin@invintelx.org',
  name: 'Admin',
  password: 'a-long-enough-password',
};
const MEMBER = {
  email: 'member@invintelx.org',
  name: 'Member',
  password: 'another-long-enough-password',
};

async function register(credentials: typeof ADMIN): Promise<string> {
  const response = await request(app).post('/api/auth/register').send(credentials).expect(201);
  const cookies = response.headers['set-cookie'];
  const header = Array.isArray(cookies) ? cookies[0] : cookies;
  if (!header) throw new Error('register did not set a session cookie');
  return header.split(';')[0] ?? '';
}

/** The trail for one entity, read through the API rather than out of the collection. */
async function trail(cookie: string, entityType: string, entityId: string): Promise<AuditEntry[]> {
  const response = await request(app)
    .get(`/api/audit/${entityType}/${entityId}`)
    .set('Cookie', cookie)
    .expect(200);
  return response.body.data as AuditEntry[];
}

function changeFor(entry: AuditEntry, field: string) {
  return entry.changes.find((change) => change.field === field);
}

/** The mapping the import screen would have offered for this file. */
function mappingFor(csv: string): ItemCsvMapping {
  return autoMapColumns(parseCsv(csv)[0]?.fields ?? []);
}

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });

  process.env.NODE_ENV = 'test';
  process.env.MONGODB_URI = replSet.getUri();
  process.env.MONGODB_DB = 'invintelx_audit_test';
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
    db.suppliers().deleteMany({}),
    db.supplierItems().deleteMany({}),
    db.users().deleteMany({}),
    db.sessions().deleteMany({}),
    db.auditEntries().deleteMany({}),
  ]);
});

describe('what gets recorded', () => {
  it('records who created an item and what it was created with', async () => {
    const cookie = await register(ADMIN);

    const created = await request(app)
      .post('/api/items')
      .set('Cookie', cookie)
      .send({ sku: 'BOLT-1', name: 'Bolt', unitCostCents: 500 })
      .expect(201);

    const entries = await trail(cookie, 'item', created.body.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      action: 'create',
      entityType: 'item',
      entityLabel: 'BOLT-1',
      actorName: 'Admin',
    });
    expect(changeFor(entries[0]!, 'unitCostCents')).toEqual({
      field: 'unitCostCents',
      before: null,
      after: 500,
      redacted: false,
    });
  });

  it('records a cost change with the value it replaced', async () => {
    const cookie = await register(ADMIN);
    const created = await request(app)
      .post('/api/items')
      .set('Cookie', cookie)
      .send({ sku: 'BOLT-1', name: 'Bolt', unitCostCents: 500, reorderPoint: 10 })
      .expect(201);

    await request(app)
      .patch(`/api/items/${created.body.id}`)
      .set('Cookie', cookie)
      .send({ unitCostCents: 750 })
      .expect(200);

    const [latest] = await trail(cookie, 'item', created.body.id);
    expect(latest?.action).toBe('update');
    expect(changeFor(latest!, 'unitCostCents')).toEqual({
      field: 'unitCostCents',
      before: 500,
      after: 750,
      redacted: false,
    });
    // Only what moved. The reorder point was not touched, so it is not on the row.
    expect(changeFor(latest!, 'reorderPoint')).toBeUndefined();
  });

  it('records a reorder point change, which the ledger has never had a place for', async () => {
    const cookie = await register(ADMIN);
    const created = await request(app)
      .post('/api/items')
      .set('Cookie', cookie)
      .send({ sku: 'BOLT-1', name: 'Bolt', reorderPoint: 10 })
      .expect(201);

    await request(app)
      .patch(`/api/items/${created.body.id}`)
      .set('Cookie', cookie)
      .send({ reorderPoint: 40 })
      .expect(200);

    const [latest] = await trail(cookie, 'item', created.body.id);
    expect(changeFor(latest!, 'reorderPoint')).toMatchObject({ before: 10, after: 40 });
  });

  it('names an archival as an archival rather than as a status edit', async () => {
    const cookie = await register(ADMIN);
    const created = await request(app)
      .post('/api/items')
      .set('Cookie', cookie)
      .send({ sku: 'BOLT-1', name: 'Bolt' })
      .expect(201);

    await request(app)
      .post(`/api/items/${created.body.id}/archive`)
      .set('Cookie', cookie)
      .expect(200);
    await request(app)
      .post(`/api/items/${created.body.id}/restore`)
      .set('Cookie', cookie)
      .expect(200);

    const entries = await trail(cookie, 'item', created.body.id);
    expect(entries.map((entry) => entry.action)).toEqual(['restore', 'archive', 'create']);
    expect(changeFor(entries[1]!, 'status')).toMatchObject({
      before: 'active',
      after: 'archived',
    });
  });

  it('records a location being deactivated', async () => {
    const cookie = await register(ADMIN);
    const site = await request(app)
      .post('/api/locations')
      .set('Cookie', cookie)
      .send({ code: 'SITE-1', name: 'Main', type: 'site' })
      .expect(201);

    await request(app)
      .patch(`/api/locations/${site.body.id}`)
      .set('Cookie', cookie)
      .send({ isActive: false })
      .expect(200);

    const [latest] = await trail(cookie, 'location', site.body.id);
    expect(latest?.entityLabel).toBe('SITE-1');
    expect(changeFor(latest!, 'isActive')).toMatchObject({ before: true, after: false });
  });

  it('names a supplier contact change by its path, not as two objects', async () => {
    const cookie = await register(ADMIN);
    const supplier = await request(app)
      .post('/api/suppliers')
      .set('Cookie', cookie)
      .send({ code: 'ACME', name: 'Acme', contact: { email: 'sales@acme.example' } })
      .expect(201);

    await request(app)
      .patch(`/api/suppliers/${supplier.body.id}`)
      .set('Cookie', cookie)
      .send({ contact: { email: 'orders@acme.example' } })
      .expect(200);

    const [latest] = await trail(cookie, 'supplier', supplier.body.id);
    expect(changeFor(latest!, 'contact.email')).toMatchObject({
      before: 'sales@acme.example',
      after: 'orders@acme.example',
    });
  });

  it('keeps the terms of a supply line that was deleted', async () => {
    const cookie = await register(ADMIN);
    const item = await request(app)
      .post('/api/items')
      .set('Cookie', cookie)
      .send({ sku: 'BOLT-1', name: 'Bolt' })
      .expect(201);
    const supplier = await request(app)
      .post('/api/suppliers')
      .set('Cookie', cookie)
      .send({ code: 'ACME', name: 'Acme' })
      .expect(201);

    const line = await request(app)
      .post(`/api/suppliers/${supplier.body.id}/items`)
      .set('Cookie', cookie)
      .send({
        itemId: item.body.id,
        supplierSku: 'ACME-BOLT',
        priceBreaks: [{ minQuantity: 1, unitPriceCents: 450 }],
      })
      .expect(201);

    await request(app)
      .delete(`/api/suppliers/${supplier.body.id}/items/${item.body.id}`)
      .set('Cookie', cookie)
      .expect(204);

    const [latest] = await trail(cookie, 'supplierItem', line.body.id);
    expect(latest?.action).toBe('delete');
    // The row is gone; what it said is not. This is the only edit in the
    // product where the log holds the sole surviving copy.
    expect(changeFor(latest!, 'priceBreaks')?.before).toEqual([
      { minQuantity: 1, unitPriceCents: 450 },
    ]);
  });

  it('records one entry per row of a CSV import, against the item itself', async () => {
    const cookie = await register(ADMIN);
    const existing = await request(app)
      .post('/api/items')
      .set('Cookie', cookie)
      .send({ sku: 'BOLT-1', name: 'Bolt', unitCostCents: 500 })
      .expect(201);

    const csv = 'sku,name,unitCost\r\nBOLT-1,Bolt,7.50\r\nNUT-1,Nut,1.00\r\n';
    await request(app)
      .post('/api/items/import')
      .set('Cookie', cookie)
      .send({ csv, mapping: mappingFor(csv) })
      .expect(200);

    const updated = await trail(cookie, 'item', existing.body.id);
    expect(updated[0]?.action).toBe('import');
    expect(changeFor(updated[0]!, 'unitCostCents')).toMatchObject({ before: 500, after: 750 });

    const created = await db.items().findOne({ sku: 'NUT-1' });
    const createdTrail = await trail(cookie, 'item', created!._id.toHexString());
    expect(createdTrail).toHaveLength(1);
    expect(createdTrail[0]?.action).toBe('import');
  });
});

describe('secrets', () => {
  it('records that an account was created without recording its password', async () => {
    const cookie = await register(ADMIN);
    const user = await db.users().findOne({ email: ADMIN.email });

    const entries = await trail(cookie, 'user', user!._id.toHexString());
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ action: 'create', entityLabel: ADMIN.email });

    // The role is the reason this entry exists: an instance's first account is
    // its administrator, and that has to be answerable.
    expect(changeFor(entries[0]!, 'role')).toMatchObject({ before: null, after: 'admin' });

    expect(changeFor(entries[0]!, 'passwordHash')).toEqual({
      field: 'passwordHash',
      before: null,
      after: null,
      redacted: true,
    });
    // Asserted against the whole serialised entry, so a hash leaking through
    // some other field would still fail this.
    expect(JSON.stringify(entries[0])).not.toContain('argon2');
  });

  it('stores no password material in the collection itself', async () => {
    await register(ADMIN);
    const stored = await db.auditEntries().find({ entityType: 'user' }).toArray();
    expect(stored.length).toBeGreaterThan(0);
    expect(JSON.stringify(stored)).not.toContain('argon2');
  });
});

describe('a mutation and its record are one write', () => {
  it('writes no entry when the mutation is refused', async () => {
    const cookie = await register(ADMIN);
    await request(app)
      .post('/api/items')
      .set('Cookie', cookie)
      .send({ sku: 'BOLT-1', name: 'Bolt' })
      .expect(201);

    // The unique index refuses this, after the audit insert has already been
    // staged in the same transaction. Both have to roll back together.
    await request(app)
      .post('/api/items')
      .set('Cookie', cookie)
      .send({ sku: 'BOLT-1', name: 'Bolt again' })
      .expect(409);

    const entries = await db.auditEntries().find({ entityType: 'item' }).toArray();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.entityLabel).toBe('BOLT-1');
  });

  it('leaves no entries behind when an import is refused as a whole', async () => {
    const cookie = await register(ADMIN);
    const before = await db.auditEntries().countDocuments({ action: 'import' });

    // One bad row takes the file down, and with it every entry the good rows
    // would have written.
    const csv = 'sku,name\r\nNUT-1,Nut\r\n,Missing SKU\r\n';
    await request(app)
      .post('/api/items/import')
      .set('Cookie', cookie)
      .send({ csv, mapping: mappingFor(csv) })
      .expect(400);

    expect(await db.auditEntries().countDocuments({ action: 'import' })).toBe(before);
    expect(await db.items().countDocuments({})).toBe(0);
  });
});

describe('who can read what', () => {
  it('lets any signed-in user read the history of a record they can see', async () => {
    const adminCookie = await register(ADMIN);
    const memberCookie = await register(MEMBER);

    const created = await request(app)
      .post('/api/items')
      .set('Cookie', adminCookie)
      .send({ sku: 'BOLT-1', name: 'Bolt' })
      .expect(201);

    const entries = await trail(memberCookie, 'item', created.body.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.actorName).toBe('Admin');
  });

  it('refuses the global feed to anyone below admin', async () => {
    await register(ADMIN);
    const memberCookie = await register(MEMBER);

    await request(app).get('/api/audit').set('Cookie', memberCookie).expect(403);
  });

  it('gives an admin every edit, newest first, and filters it', async () => {
    const cookie = await register(ADMIN);
    const item = await request(app)
      .post('/api/items')
      .set('Cookie', cookie)
      .send({ sku: 'BOLT-1', name: 'Bolt' })
      .expect(201);
    await request(app)
      .post(`/api/items/${item.body.id}/archive`)
      .set('Cookie', cookie)
      .expect(200);

    const all = await request(app).get('/api/audit').set('Cookie', cookie).expect(200);
    // The registration is in here too, which is the point of a global feed.
    expect(all.body.data.map((entry: AuditEntry) => entry.action)).toEqual([
      'archive',
      'create',
      'create',
    ]);

    const archives = await request(app)
      .get('/api/audit?action=archive')
      .set('Cookie', cookie)
      .expect(200);
    expect(archives.body.data).toHaveLength(1);
    expect(archives.body.data[0].entityLabel).toBe('BOLT-1');

    const users = await request(app)
      .get('/api/audit?entityType=user')
      .set('Cookie', cookie)
      .expect(200);
    expect(users.body.data).toHaveLength(1);
    expect(users.body.data[0].entityLabel).toBe(ADMIN.email);
  });

  it('answers an empty page for an entity with no history, not a 404', async () => {
    const cookie = await register(ADMIN);
    // The log outlives what it describes, so "no rows" is a legitimate answer
    // for an id that no longer resolves to anything.
    const response = await request(app)
      .get('/api/audit/item/0123456789abcdef01234567')
      .set('Cookie', cookie)
      .expect(200);
    expect(response.body).toMatchObject({ data: [], total: 0, totalPages: 1 });
  });

  it('rejects a kind of record that does not exist', async () => {
    const cookie = await register(ADMIN);
    await request(app)
      .get('/api/audit/wishlist/0123456789abcdef01234567')
      .set('Cookie', cookie)
      .expect(404);
  });

  it('needs a session at all', async () => {
    await request(app).get('/api/audit').expect(401);
  });
});
