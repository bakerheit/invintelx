import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import request from 'supertest';
import type { Express } from 'express';
import type * as DbModule from '../db.js';

/**
 * Integration tests against a real mongod. Two of the guarantees here - a
 * supplier code that cannot fork on case, and a supplier part number that is
 * unique within a supplier however it is typed - live in index definitions, and
 * only a real index can be asked whether they hold.
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

async function createSupplier(
  cookie: string,
  body: Record<string, unknown>,
): Promise<{ id: string; [key: string]: unknown }> {
  const response = await request(app)
    .post('/api/suppliers')
    .set('Cookie', cookie)
    .send(body)
    .expect(201);
  return response.body as { id: string };
}

async function createItem(cookie: string, sku: string, name = 'A thing'): Promise<string> {
  const response = await request(app)
    .post('/api/items')
    .set('Cookie', cookie)
    .send({ sku, name })
    .expect(201);
  return (response.body as { id: string }).id;
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
    db.suppliers().deleteMany({}),
    db.supplierItems().deleteMany({}),
    db.items().deleteMany({}),
    db.users().deleteMany({}),
    db.sessions().deleteMany({}),
  ]);
});

describe('suppliers', () => {
  it('requires authentication', async () => {
    await request(app).get('/api/suppliers').expect(401);
  });

  it('creates with defaults filled in, uppercases the code, and lists', async () => {
    const cookie = await signIn();

    const created = await createSupplier(cookie, { code: 'acme-1', name: 'Acme Supplies' });
    expect(created.code).toBe('ACME-1');
    expect(created.status).toBe('active');
    expect(created.paymentTerms).toBe('net_30');
    expect(created.currency).toBe('USD');
    expect(created.promisedLeadTimeDays).toBe(14);
    expect(created.contact).toEqual({
      name: '',
      email: '',
      phone: '',
      website: '',
      address: '',
    });

    const list = await request(app).get('/api/suppliers').set('Cookie', cookie).expect(200);
    expect(list.body.total).toBe(1);
    expect(list.body.data[0].code).toBe('ACME-1');
  });

  it('keeps the promised lead time exactly as given, since it is a claim not a measurement', async () => {
    const cookie = await signIn();
    const created = await createSupplier(cookie, {
      code: 'slow-1',
      name: 'Slow but cheap',
      promisedLeadTimeDays: 45,
    });
    expect(created.promisedLeadTimeDays).toBe(45);

    const fetched = await request(app)
      .get(`/api/suppliers/${created.id}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(fetched.body.promisedLeadTimeDays).toBe(45);
  });

  it('rejects a duplicate code with a 409 the form can render', async () => {
    const cookie = await signIn();
    await createSupplier(cookie, { code: 'dupe-1', name: 'First' });

    const conflict = await request(app)
      .post('/api/suppliers')
      .set('Cookie', cookie)
      .send({ code: 'DUPE-1', name: 'Second' })
      .expect(409);
    expect(conflict.body.error.fields.code).toBeDefined();
  });

  it('returns per-field messages for invalid input', async () => {
    const cookie = await signIn();
    const response = await request(app)
      .post('/api/suppliers')
      .set('Cookie', cookie)
      .send({
        code: 'bad code',
        name: '',
        promisedLeadTimeDays: 2.5,
        currency: 'DOLLARS',
        contact: { email: 'not-an-address' },
      })
      .expect(400);

    expect(Object.keys(response.body.error.fields)).toEqual(
      expect.arrayContaining(['code', 'name', 'promisedLeadTimeDays', 'currency', 'contact.email']),
    );
  });

  it('patches one contact field without wiping the rest of the block', async () => {
    const cookie = await signIn();
    const created = await createSupplier(cookie, {
      code: 'acme-2',
      name: 'Acme',
      contact: {
        name: 'Dana',
        email: 'dana@acme.example',
        phone: '0100 000000',
        address: '1 Acme Way',
      },
    });

    const patched = await request(app)
      .patch(`/api/suppliers/${created.id}`)
      .set('Cookie', cookie)
      .send({ contact: { phone: '0100 999999' } })
      .expect(200);

    expect(patched.body.contact.phone).toBe('0100 999999');
    expect(patched.body.contact.email).toBe('dana@acme.example');
    expect(patched.body.contact.name).toBe('Dana');
    expect(patched.body.contact.address).toBe('1 Acme Way');
  });

  it('hides archived suppliers by default and finds them on request', async () => {
    const cookie = await signIn();
    const created = await createSupplier(cookie, { code: 'gone-1', name: 'Soon archived' });

    await request(app)
      .post(`/api/suppliers/${created.id}/archive`)
      .set('Cookie', cookie)
      .expect(200);

    const active = await request(app).get('/api/suppliers').set('Cookie', cookie).expect(200);
    expect(active.body.total).toBe(0);

    const archived = await request(app)
      .get('/api/suppliers?status=archived')
      .set('Cookie', cookie)
      .expect(200);
    expect(archived.body.total).toBe(1);

    await request(app)
      .post(`/api/suppliers/${created.id}/restore`)
      .set('Cookie', cookie)
      .expect(200);
    const restored = await request(app).get('/api/suppliers').set('Cookie', cookie).expect(200);
    expect(restored.body.total).toBe(1);
  });

  it('searches code, name and contact, treating metacharacters as literal text', async () => {
    const cookie = await signIn();
    await createSupplier(cookie, {
      code: 'plain-1',
      name: 'Plain supplier',
      contact: { name: 'Dana Scully', email: 'dana@plain.example' },
    });

    const byContact = await request(app)
      .get('/api/suppliers?q=scully')
      .set('Cookie', cookie)
      .expect(200);
    expect(byContact.body.total).toBe(1);

    // '.*' would match everything if it reached the regex engine unescaped.
    const metacharacters = await request(app)
      .get('/api/suppliers?q=.*')
      .set('Cookie', cookie)
      .expect(200);
    expect(metacharacters.body.total).toBe(0);
  });

  it('filters by payment terms', async () => {
    const cookie = await signIn();
    await createSupplier(cookie, { code: 'cash-1', name: 'Cash only', paymentTerms: 'cod' });
    await createSupplier(cookie, { code: 'net-1', name: 'On account', paymentTerms: 'net_60' });

    const cod = await request(app)
      .get('/api/suppliers?paymentTerms=cod')
      .set('Cookie', cookie)
      .expect(200);
    expect(cod.body.total).toBe(1);
    expect(cod.body.data[0].code).toBe('CASH-1');
  });

  it('paginates without dropping or repeating rows across pages', async () => {
    const cookie = await signIn();
    for (let i = 1; i <= 7; i += 1) {
      await createSupplier(cookie, { code: `page-${i}`, name: `Supplier ${i}` });
    }

    const first = await request(app)
      .get('/api/suppliers?pageSize=3&page=1&sort=code&order=asc')
      .set('Cookie', cookie)
      .expect(200);
    const second = await request(app)
      .get('/api/suppliers?pageSize=3&page=2&sort=code&order=asc')
      .set('Cookie', cookie)
      .expect(200);

    expect(first.body.total).toBe(7);
    expect(first.body.totalPages).toBe(3);
    const codes = [...first.body.data, ...second.body.data].map((s: { code: string }) => s.code);
    expect(new Set(codes).size).toBe(6);
  });

  it('404s on an id that is not a valid ObjectId rather than throwing', async () => {
    const cookie = await signIn();
    await request(app).get('/api/suppliers/not-a-real-id').set('Cookie', cookie).expect(404);
  });

  it('refuses writes from a viewer but still allows reads', async () => {
    const cookie = await signIn();
    await db.users().updateOne({}, { $set: { role: 'viewer' } });

    await request(app).get('/api/suppliers').set('Cookie', cookie).expect(200);
    await request(app)
      .post('/api/suppliers')
      .set('Cookie', cookie)
      .send({ code: 'nope-1', name: 'Should not be created' })
      .expect(403);
  });
});

describe('supplier catalogue', () => {
  it('links an item with a supplier SKU and price breaks, and reads them back sorted', async () => {
    const cookie = await signIn();
    const supplier = await createSupplier(cookie, { code: 'acme-3', name: 'Acme' });
    const itemId = await createItem(cookie, 'bolt-1', 'Hex bolt');

    const created = await request(app)
      .post(`/api/suppliers/${supplier.id}/items`)
      .set('Cookie', cookie)
      .send({
        itemId,
        supplierSku: 'ACME-BOLT-M6',
        priceBreaks: [
          { minQuantity: 100, unitPriceCents: 80 },
          { minQuantity: 1, unitPriceCents: 100 },
        ],
      })
      .expect(201);

    // Canonicalised on the way in, so no reader has to sort it themselves.
    expect(created.body.priceBreaks).toEqual([
      { minQuantity: 1, unitPriceCents: 100 },
      { minQuantity: 100, unitPriceCents: 80 },
    ]);
    expect(created.body.supplierSku).toBe('ACME-BOLT-M6');

    const list = await request(app)
      .get(`/api/suppliers/${supplier.id}/items`)
      .set('Cookie', cookie)
      .expect(200);
    expect(list.body.total).toBe(1);
    // The item is resolved at read time, so the line carries its current name.
    expect(list.body.data[0].item.sku).toBe('BOLT-1');
    expect(list.body.data[0].item.name).toBe('Hex bolt');
  });

  it('shows a renamed item under its new name, because the link stores no copy', async () => {
    const cookie = await signIn();
    const supplier = await createSupplier(cookie, { code: 'acme-4', name: 'Acme' });
    const itemId = await createItem(cookie, 'bolt-2', 'Old name');

    await request(app)
      .post(`/api/suppliers/${supplier.id}/items`)
      .set('Cookie', cookie)
      .send({ itemId, supplierSku: 'A-2' })
      .expect(201);

    await request(app)
      .patch(`/api/items/${itemId}`)
      .set('Cookie', cookie)
      .send({ name: 'New name' })
      .expect(200);

    const list = await request(app)
      .get(`/api/suppliers/${supplier.id}/items`)
      .set('Cookie', cookie)
      .expect(200);
    expect(list.body.data[0].item.name).toBe('New name');
  });

  it('refuses a second line for the same item', async () => {
    const cookie = await signIn();
    const supplier = await createSupplier(cookie, { code: 'acme-5', name: 'Acme' });
    const itemId = await createItem(cookie, 'bolt-3');

    await request(app)
      .post(`/api/suppliers/${supplier.id}/items`)
      .set('Cookie', cookie)
      .send({ itemId, supplierSku: 'FIRST' })
      .expect(201);

    const conflict = await request(app)
      .post(`/api/suppliers/${supplier.id}/items`)
      .set('Cookie', cookie)
      .send({ itemId, supplierSku: 'SECOND' })
      .expect(409);
    expect(conflict.body.error.fields.itemId).toBeDefined();
  });

  it("keeps the supplier's own casing but refuses a part number that differs only in case", async () => {
    const cookie = await signIn();
    const supplier = await createSupplier(cookie, { code: 'acme-6', name: 'Acme' });
    const first = await createItem(cookie, 'bolt-4');
    const second = await createItem(cookie, 'bolt-5');

    const created = await request(app)
      .post(`/api/suppliers/${supplier.id}/items`)
      .set('Cookie', cookie)
      .send({ itemId: first, supplierSku: 'aBc-1' })
      .expect(201);
    expect(created.body.supplierSku).toBe('aBc-1');

    const conflict = await request(app)
      .post(`/api/suppliers/${supplier.id}/items`)
      .set('Cookie', cookie)
      .send({ itemId: second, supplierSku: 'ABC-1' })
      .expect(409);
    expect(conflict.body.error.fields.supplierSku).toBeDefined();
  });

  it('lets two suppliers use the same part number as each other', async () => {
    const cookie = await signIn();
    const one = await createSupplier(cookie, { code: 'one-1', name: 'One' });
    const two = await createSupplier(cookie, { code: 'two-1', name: 'Two' });
    const itemId = await createItem(cookie, 'bolt-6');

    for (const supplier of [one, two]) {
      await request(app)
        .post(`/api/suppliers/${supplier.id}/items`)
        .set('Cookie', cookie)
        .send({ itemId, supplierSku: 'SHARED-1' })
        .expect(201);
    }
  });

  it('refuses a line for an archived item, and for an item that does not exist', async () => {
    const cookie = await signIn();
    const supplier = await createSupplier(cookie, { code: 'acme-7', name: 'Acme' });
    const itemId = await createItem(cookie, 'bolt-7');
    await request(app).post(`/api/items/${itemId}/archive`).set('Cookie', cookie).expect(200);

    const archived = await request(app)
      .post(`/api/suppliers/${supplier.id}/items`)
      .set('Cookie', cookie)
      .send({ itemId, supplierSku: 'A-7' })
      .expect(400);
    expect(archived.body.error.fields.itemId).toBeDefined();

    await request(app)
      .post(`/api/suppliers/${supplier.id}/items`)
      .set('Cookie', cookie)
      .send({ itemId: '0'.repeat(24), supplierSku: 'A-8' })
      .expect(404);
  });

  it('404s when the supplier itself does not exist', async () => {
    const cookie = await signIn();
    const missing = '0'.repeat(24);
    await request(app).get(`/api/suppliers/${missing}/items`).set('Cookie', cookie).expect(404);
    await request(app)
      .post(`/api/suppliers/${missing}/items`)
      .set('Cookie', cookie)
      .send({ itemId: '0'.repeat(24), supplierSku: 'X-1' })
      .expect(404);
  });

  it('rejects a ladder with two rungs starting at the same quantity', async () => {
    const cookie = await signIn();
    const supplier = await createSupplier(cookie, { code: 'acme-8', name: 'Acme' });
    const itemId = await createItem(cookie, 'bolt-8');

    await request(app)
      .post(`/api/suppliers/${supplier.id}/items`)
      .set('Cookie', cookie)
      .send({
        itemId,
        supplierSku: 'A-9',
        priceBreaks: [
          { minQuantity: 10, unitPriceCents: 90 },
          { minQuantity: 10, unitPriceCents: 80 },
        ],
      })
      .expect(400);
  });

  it('updates a line, and removes it without touching the item or the supplier', async () => {
    const cookie = await signIn();
    const supplier = await createSupplier(cookie, { code: 'acme-9', name: 'Acme' });
    const itemId = await createItem(cookie, 'bolt-9');

    await request(app)
      .post(`/api/suppliers/${supplier.id}/items`)
      .set('Cookie', cookie)
      .send({ itemId, supplierSku: 'OLD-SKU' })
      .expect(201);

    const patched = await request(app)
      .patch(`/api/suppliers/${supplier.id}/items/${itemId}`)
      .set('Cookie', cookie)
      .send({ supplierSku: 'NEW-SKU', priceBreaks: [{ minQuantity: 1, unitPriceCents: 250 }] })
      .expect(200);
    expect(patched.body.supplierSku).toBe('NEW-SKU');
    expect(patched.body.priceBreaks).toEqual([{ minQuantity: 1, unitPriceCents: 250 }]);

    await request(app)
      .delete(`/api/suppliers/${supplier.id}/items/${itemId}`)
      .set('Cookie', cookie)
      .expect(204);

    const list = await request(app)
      .get(`/api/suppliers/${supplier.id}/items`)
      .set('Cookie', cookie)
      .expect(200);
    expect(list.body.total).toBe(0);

    // Removing a supply line says nothing about the item or the supplier.
    await request(app).get(`/api/items/${itemId}`).set('Cookie', cookie).expect(200);
    await request(app).get(`/api/suppliers/${supplier.id}`).set('Cookie', cookie).expect(200);
  });

  it('404s on patching or deleting a line this supplier does not have', async () => {
    const cookie = await signIn();
    const supplier = await createSupplier(cookie, { code: 'acme-10', name: 'Acme' });
    const itemId = await createItem(cookie, 'bolt-10');

    await request(app)
      .patch(`/api/suppliers/${supplier.id}/items/${itemId}`)
      .set('Cookie', cookie)
      .send({ supplierSku: 'NOPE' })
      .expect(404);
    await request(app)
      .delete(`/api/suppliers/${supplier.id}/items/${itemId}`)
      .set('Cookie', cookie)
      .expect(404);
  });

  it('refuses catalogue writes from a viewer but still allows reads', async () => {
    const cookie = await signIn();
    const supplier = await createSupplier(cookie, { code: 'acme-11', name: 'Acme' });
    const itemId = await createItem(cookie, 'bolt-11');
    await db.users().updateOne({}, { $set: { role: 'viewer' } });

    await request(app)
      .get(`/api/suppliers/${supplier.id}/items`)
      .set('Cookie', cookie)
      .expect(200);
    await request(app)
      .post(`/api/suppliers/${supplier.id}/items`)
      .set('Cookie', cookie)
      .send({ itemId, supplierSku: 'X-1' })
      .expect(403);
  });
});
