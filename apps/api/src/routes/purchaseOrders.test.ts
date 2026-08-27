import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { ObjectId } from 'mongodb';
import request from 'supertest';
import type { Express } from 'express';
import type * as DbModule from '../db.js';

let replSet: MongoMemoryReplSet;
let app: Express;
let db: typeof DbModule;
let cookie: string;

const CREDENTIALS = {
  email: 'po@invintelx.org',
  name: 'Purchasing Tester',
  password: 'a-long-enough-password',
};

async function signIn(): Promise<string> {
  const response = await request(app).post('/api/auth/register').send(CREDENTIALS).expect(201);
  const cookies = response.headers['set-cookie'];
  const header = Array.isArray(cookies) ? cookies[0] : cookies;
  if (!header) throw new Error('register did not set a session cookie');
  return header.split(';')[0] ?? '';
}

/**
 * Suppliers are INVX-25's collection and it is not merged, so there is no
 * endpoint to create one from. These tests only need an order to have somebody
 * to be addressed to, so they write the four fields a purchase order reads and
 * leave the rest of the supplier model to the ticket that owns it.
 */
async function makeSupplier(
  code: string,
  status: 'active' | 'archived' = 'active',
): Promise<string> {
  const id = new ObjectId();
  await db
    .getDb()
    .collection('suppliers')
    .insertOne({ _id: id, code, name: `${code} Supplies Ltd`, status });
  return id.toHexString();
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

function post(path: string) {
  return request(app).post(path).set('Cookie', cookie);
}

function get(path: string) {
  return request(app).get(path).set('Cookie', cookie);
}

/** A sent order with the given lines, which is where most of these start. */
async function sentOrder(
  supplierId: string,
  lines: { itemId: string; quantity: number; unitCostCents?: number }[],
) {
  const created = await post('/api/purchase-orders')
    .send({ supplierId, lines })
    .expect(201);
  const sent = await post(`/api/purchase-orders/${created.body.id}/send`).send({}).expect(200);
  return sent.body;
}

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });

  process.env.NODE_ENV = 'test';
  process.env.MONGODB_URI = replSet.getUri();
  process.env.MONGODB_DB = 'invintelx_purchase_orders_test';
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
    db.purchaseOrders().deleteMany({}),
    db.counters().deleteMany({}),
    db.getDb().collection('suppliers').deleteMany({}),
    db.users().deleteMany({}),
    db.sessions().deleteMany({}),
  ]);
  cookie = await signIn();
});

describe('raising an order', () => {
  it('starts as a draft carrying the supplier and the lines', async () => {
    const supplierId = await makeSupplier('ACME');
    const itemId = await makeItem('PO-WIDGET');

    const response = await post('/api/purchase-orders')
      .send({
        supplierId,
        expectedDate: '2026-09-15T00:00:00.000Z',
        reference: 'their quote 88',
        lines: [{ itemId, quantity: 10, unitCostCents: 250 }],
      })
      .expect(201);

    expect(response.body.status).toBe('draft');
    expect(response.body.number).toBe('PO-00001');
    expect(response.body.supplierCode).toBe('ACME');
    expect(response.body.supplierName).toBe('ACME Supplies Ltd');
    expect(response.body.expectedDate).toBe('2026-09-15T00:00:00.000Z');
    expect(response.body.reference).toBe('their quote 88');
    expect(response.body.sentAt).toBeNull();
    expect(response.body.closedAt).toBeNull();

    expect(response.body.lines).toHaveLength(1);
    const [line] = response.body.lines;
    expect(line.itemSku).toBe('PO-WIDGET');
    expect(line.quantityOrdered).toBe(10);
    expect(line.quantityReceived).toBe(0);
    expect(line.quantityOutstanding).toBe(10);
    expect(line.lineTotalCents).toBe(2500);
    expect(response.body.totalCents).toBe(2500);
  });

  it('numbers orders in sequence', async () => {
    const supplierId = await makeSupplier('ACME');
    const first = await post('/api/purchase-orders').send({ supplierId }).expect(201);
    const second = await post('/api/purchase-orders').send({ supplierId }).expect(201);
    expect([first.body.number, second.body.number]).toEqual(['PO-00001', 'PO-00002']);
  });

  it('accepts a draft with no lines yet', async () => {
    const supplierId = await makeSupplier('ACME');
    const response = await post('/api/purchase-orders').send({ supplierId }).expect(201);
    expect(response.body.lines).toEqual([]);
    expect(response.body.totalCents).toBe(0);
  });

  it('refuses an unknown supplier', async () => {
    const response = await post('/api/purchase-orders')
      .send({ supplierId: new ObjectId().toHexString() })
      .expect(404);
    expect(response.body.error.message).toBe('No supplier with that id');
  });

  it('refuses an archived supplier', async () => {
    const supplierId = await makeSupplier('GONE', 'archived');
    const response = await post('/api/purchase-orders').send({ supplierId }).expect(400);
    expect(response.body.error.fields.supplierId).toBe('Supplier is archived');
  });

  it('refuses the whole order when one line names an unknown item', async () => {
    const supplierId = await makeSupplier('ACME');
    const itemId = await makeItem('PO-GOOD');

    const response = await post('/api/purchase-orders')
      .send({
        supplierId,
        lines: [
          { itemId, quantity: 1 },
          { itemId: new ObjectId().toHexString(), quantity: 1 },
        ],
      })
      .expect(400);

    expect(response.body.error.fields['lines.1.itemId']).toBe('Unknown item');
    expect(await db.purchaseOrders().countDocuments({})).toBe(0);
  });

  it('refuses an archived item', async () => {
    const supplierId = await makeSupplier('ACME');
    const itemId = await makeItem('PO-OLD');
    await post(`/api/items/${itemId}/archive`).send({}).expect(200);

    const response = await post('/api/purchase-orders')
      .send({ supplierId, lines: [{ itemId, quantity: 1 }] })
      .expect(400);
    expect(response.body.error.fields['lines.0.itemId']).toBe('Item is archived');
  });
});

describe('sending an order', () => {
  it('moves a draft to sent and stamps when', async () => {
    const supplierId = await makeSupplier('ACME');
    const itemId = await makeItem('PO-SEND');
    const created = await post('/api/purchase-orders')
      .send({ supplierId, lines: [{ itemId, quantity: 3 }] })
      .expect(201);

    const sent = await post(`/api/purchase-orders/${created.body.id}/send`).send({}).expect(200);
    expect(sent.body.status).toBe('sent');
    expect(sent.body.sentAt).not.toBeNull();
  });

  it('refuses to send an order that asks for nothing', async () => {
    const supplierId = await makeSupplier('ACME');
    const created = await post('/api/purchase-orders').send({ supplierId }).expect(201);
    const response = await post(`/api/purchase-orders/${created.body.id}/send`)
      .send({})
      .expect(400);
    expect(response.body.error.fields.lines).toBe('Order has no lines');
  });

  it('refuses to send the same order twice', async () => {
    const supplierId = await makeSupplier('ACME');
    const itemId = await makeItem('PO-TWICE');
    const order = await sentOrder(supplierId, [{ itemId, quantity: 1 }]);
    const response = await post(`/api/purchase-orders/${order.id}/send`).send({}).expect(400);
    expect(response.body.error.fields.status).toBe('Order is sent');
  });
});

describe('editing an order', () => {
  it('lets a draft be rewritten', async () => {
    const supplierId = await makeSupplier('ACME');
    const first = await makeItem('PO-A');
    const second = await makeItem('PO-B');
    const created = await post('/api/purchase-orders')
      .send({ supplierId, lines: [{ itemId: first, quantity: 1 }] })
      .expect(201);

    const updated = await request(app)
      .patch(`/api/purchase-orders/${created.body.id}`)
      .set('Cookie', cookie)
      .send({ lines: [{ itemId: second, quantity: 4, unitCostCents: 100 }] })
      .expect(200);

    expect(updated.body.lines).toHaveLength(1);
    expect(updated.body.lines[0].itemSku).toBe('PO-B');
    expect(updated.body.totalCents).toBe(400);
  });

  it('freezes the lines once the supplier has the order', async () => {
    const supplierId = await makeSupplier('ACME');
    const itemId = await makeItem('PO-FROZEN');
    const order = await sentOrder(supplierId, [{ itemId, quantity: 2 }]);

    const response = await request(app)
      .patch(`/api/purchase-orders/${order.id}`)
      .set('Cookie', cookie)
      .send({ lines: [{ itemId, quantity: 99 }] })
      .expect(400);
    expect(response.body.error.fields.lines).toBe('Order is sent');
  });

  it('still lets a slipped delivery date be recorded after sending', async () => {
    const supplierId = await makeSupplier('ACME');
    const itemId = await makeItem('PO-LATE');
    const order = await sentOrder(supplierId, [{ itemId, quantity: 2 }]);

    const updated = await request(app)
      .patch(`/api/purchase-orders/${order.id}`)
      .set('Cookie', cookie)
      .send({ expectedDate: '2026-10-01T00:00:00.000Z', note: 'they called, two weeks late' })
      .expect(200);
    expect(updated.body.expectedDate).toBe('2026-10-01T00:00:00.000Z');
    expect(updated.body.status).toBe('sent');
  });
});

describe('receiving against an order', () => {
  it('writes a receipt movement linked to the line and leaves the order partial', async () => {
    const supplierId = await makeSupplier('ACME');
    const itemId = await makeItem('PO-PART');
    const binId = await makeBin('PO-BIN');
    const order = await sentOrder(supplierId, [{ itemId, quantity: 10, unitCostCents: 500 }]);
    const lineId = order.lines[0].id;

    const response = await post(`/api/purchase-orders/${order.id}/receive`)
      .send({ locationId: binId, lines: [{ lineId, quantity: 4 }] })
      .expect(201);

    expect(response.body.purchaseOrder.status).toBe('partial');
    expect(response.body.purchaseOrder.lines[0].quantityReceived).toBe(4);
    expect(response.body.purchaseOrder.lines[0].quantityOutstanding).toBe(6);
    expect(response.body.purchaseOrder.closedAt).toBeNull();

    expect(response.body.movements).toHaveLength(1);
    const [posted] = response.body.movements;
    expect(posted.movement.type).toBe('receipt');
    expect(posted.movement.quantity).toBe(4);
    expect(posted.movement.reference).toBe(order.number);
    expect(posted.movement.purchaseOrderId).toBe(order.id);
    expect(posted.movement.purchaseOrderLineId).toBe(lineId);
    expect(posted.balanceAfter).toBe(4);

    const stock = await get(`/api/movements/stock/${itemId}`).expect(200);
    expect(stock.body.totalOnHand).toBe(4);
  });

  it('completes the order when the rest arrives', async () => {
    const supplierId = await makeSupplier('ACME');
    const itemId = await makeItem('PO-REST');
    const binId = await makeBin('PO-BIN');
    const order = await sentOrder(supplierId, [{ itemId, quantity: 10 }]);
    const lineId = order.lines[0].id;

    await post(`/api/purchase-orders/${order.id}/receive`)
      .send({ locationId: binId, lines: [{ lineId, quantity: 4 }] })
      .expect(201);
    const second = await post(`/api/purchase-orders/${order.id}/receive`)
      .send({ locationId: binId, lines: [{ lineId, quantity: 6 }] })
      .expect(201);

    expect(second.body.purchaseOrder.status).toBe('received');
    expect(second.body.purchaseOrder.lines[0].quantityOutstanding).toBe(0);
    expect(second.body.purchaseOrder.closedAt).not.toBeNull();
    const orderId = new ObjectId(order.id);
    expect(await db.movements().countDocuments({ purchaseOrderId: orderId })).toBe(2);
  });

  it('stays partial while any line is short', async () => {
    const supplierId = await makeSupplier('ACME');
    const first = await makeItem('PO-M1');
    const second = await makeItem('PO-M2');
    const binId = await makeBin('PO-BIN');
    const order = await sentOrder(supplierId, [
      { itemId: first, quantity: 5 },
      { itemId: second, quantity: 5 },
    ]);

    const response = await post(`/api/purchase-orders/${order.id}/receive`)
      .send({ locationId: binId, lines: [{ lineId: order.lines[0].id, quantity: 5 }] })
      .expect(201);

    expect(response.body.purchaseOrder.status).toBe('partial');
    expect(response.body.purchaseOrder.lines[1].quantityReceived).toBe(0);
  });

  it('takes several lines off one van in a single call', async () => {
    const supplierId = await makeSupplier('ACME');
    const first = await makeItem('PO-V1');
    const second = await makeItem('PO-V2');
    const binId = await makeBin('PO-BIN');
    const order = await sentOrder(supplierId, [
      { itemId: first, quantity: 5 },
      { itemId: second, quantity: 5 },
    ]);

    const response = await post(`/api/purchase-orders/${order.id}/receive`)
      .send({
        locationId: binId,
        lines: [
          { lineId: order.lines[0].id, quantity: 5 },
          { lineId: order.lines[1].id, quantity: 5 },
        ],
      })
      .expect(201);

    expect(response.body.movements).toHaveLength(2);
    expect(response.body.purchaseOrder.status).toBe('received');
  });

  it('records a supplier who shipped a spare rather than refusing the stock', async () => {
    const supplierId = await makeSupplier('ACME');
    const itemId = await makeItem('PO-OVER');
    const binId = await makeBin('PO-BIN');
    const order = await sentOrder(supplierId, [{ itemId, quantity: 10 }]);

    const response = await post(`/api/purchase-orders/${order.id}/receive`)
      .send({ locationId: binId, lines: [{ lineId: order.lines[0].id, quantity: 12 }] })
      .expect(201);

    expect(response.body.purchaseOrder.lines[0].quantityReceived).toBe(12);
    expect(response.body.purchaseOrder.lines[0].quantityOutstanding).toBe(0);
    expect(response.body.purchaseOrder.status).toBe('received');

    const stock = await get(`/api/movements/stock/${itemId}`).expect(200);
    expect(stock.body.totalOnHand).toBe(12);
  });

  it('refuses a delivery against a draft and says what to do instead', async () => {
    const supplierId = await makeSupplier('ACME');
    const itemId = await makeItem('PO-DRAFT');
    const binId = await makeBin('PO-BIN');
    const created = await post('/api/purchase-orders')
      .send({ supplierId, lines: [{ itemId, quantity: 1 }] })
      .expect(201);

    const response = await post(`/api/purchase-orders/${created.body.id}/receive`)
      .send({ locationId: binId, lines: [{ lineId: created.body.lines[0].id, quantity: 1 }] })
      .expect(400);

    expect(response.body.error.message).toContain('has not been sent yet');
    expect(await db.movements().countDocuments({})).toBe(0);
  });

  it('refuses a delivery against a completed order', async () => {
    const supplierId = await makeSupplier('ACME');
    const itemId = await makeItem('PO-DONE');
    const binId = await makeBin('PO-BIN');
    const order = await sentOrder(supplierId, [{ itemId, quantity: 2 }]);
    await post(`/api/purchase-orders/${order.id}/receive`)
      .send({ locationId: binId, lines: [{ lineId: order.lines[0].id, quantity: 2 }] })
      .expect(201);

    const response = await post(`/api/purchase-orders/${order.id}/receive`)
      .send({ locationId: binId, lines: [{ lineId: order.lines[0].id, quantity: 1 }] })
      .expect(400);
    expect(response.body.error.fields.status).toBe('Order is received');
  });

  it('refuses a line that is not on this order, writing nothing', async () => {
    const supplierId = await makeSupplier('ACME');
    const itemId = await makeItem('PO-STRAY');
    const binId = await makeBin('PO-BIN');
    const order = await sentOrder(supplierId, [{ itemId, quantity: 5 }]);

    const response = await post(`/api/purchase-orders/${order.id}/receive`)
      .send({ locationId: binId, lines: [{ lineId: new ObjectId().toHexString(), quantity: 1 }] })
      .expect(400);

    expect(response.body.error.fields['lines.0.lineId']).toBe('Not a line on this order');
    expect(await db.movements().countDocuments({})).toBe(0);
  });

  it('refuses a delivery into somewhere that does not hold stock, leaving the order alone', async () => {
    const supplierId = await makeSupplier('ACME');
    const itemId = await makeItem('PO-ZONE');
    const site = await post('/api/locations')
      .send({ code: 'PO-SITE-ONLY', name: 'Site', type: 'site' })
      .expect(201);
    const order = await sentOrder(supplierId, [{ itemId, quantity: 5 }]);

    await post(`/api/purchase-orders/${order.id}/receive`)
      .send({ locationId: site.body.id, lines: [{ lineId: order.lines[0].id, quantity: 5 }] })
      .expect(400);

    const after = await get(`/api/purchase-orders/${order.id}`).expect(200);
    expect(after.body.status).toBe('sent');
    expect(after.body.lines[0].quantityReceived).toBe(0);
    expect(await db.movements().countDocuments({})).toBe(0);
  });
});

describe('cancelling an order', () => {
  it('closes a part-delivered order without unreceiving anything', async () => {
    const supplierId = await makeSupplier('ACME');
    const itemId = await makeItem('PO-CANCEL');
    const binId = await makeBin('PO-BIN');
    const order = await sentOrder(supplierId, [{ itemId, quantity: 10 }]);
    await post(`/api/purchase-orders/${order.id}/receive`)
      .send({ locationId: binId, lines: [{ lineId: order.lines[0].id, quantity: 4 }] })
      .expect(201);

    const cancelled = await post(`/api/purchase-orders/${order.id}/cancel`).send({}).expect(200);
    expect(cancelled.body.status).toBe('cancelled');
    expect(cancelled.body.lines[0].quantityReceived).toBe(4);
    expect(cancelled.body.closedAt).not.toBeNull();

    const stock = await get(`/api/movements/stock/${itemId}`).expect(200);
    expect(stock.body.totalOnHand).toBe(4);
  });

  it('refuses anything further once cancelled', async () => {
    const supplierId = await makeSupplier('ACME');
    const itemId = await makeItem('PO-DEAD');
    const binId = await makeBin('PO-BIN');
    const order = await sentOrder(supplierId, [{ itemId, quantity: 10 }]);
    await post(`/api/purchase-orders/${order.id}/cancel`).send({}).expect(200);

    const received = await post(`/api/purchase-orders/${order.id}/receive`)
      .send({ locationId: binId, lines: [{ lineId: order.lines[0].id, quantity: 1 }] })
      .expect(400);
    expect(received.body.error.fields.status).toBe('Order is cancelled');

    await post(`/api/purchase-orders/${order.id}/cancel`).send({}).expect(400);
  });

  it('refuses to cancel a completed order', async () => {
    const supplierId = await makeSupplier('ACME');
    const itemId = await makeItem('PO-FULL');
    const binId = await makeBin('PO-BIN');
    const order = await sentOrder(supplierId, [{ itemId, quantity: 1 }]);
    await post(`/api/purchase-orders/${order.id}/receive`)
      .send({ locationId: binId, lines: [{ lineId: order.lines[0].id, quantity: 1 }] })
      .expect(201);

    const response = await post(`/api/purchase-orders/${order.id}/cancel`).send({}).expect(400);
    expect(response.body.error.fields.status).toBe('Order is received');
  });
});

describe('reversing a receipt taken against an order', () => {
  it('takes the quantity back off the line and reopens the order', async () => {
    const supplierId = await makeSupplier('ACME');
    const itemId = await makeItem('PO-REV');
    const binId = await makeBin('PO-BIN');
    const order = await sentOrder(supplierId, [{ itemId, quantity: 10 }]);
    const lineId = order.lines[0].id;

    const first = await post(`/api/purchase-orders/${order.id}/receive`)
      .send({ locationId: binId, lines: [{ lineId, quantity: 4 }] })
      .expect(201);
    const second = await post(`/api/purchase-orders/${order.id}/receive`)
      .send({ locationId: binId, lines: [{ lineId, quantity: 6 }] })
      .expect(201);
    expect(second.body.purchaseOrder.status).toBe('received');

    const reversal = await post(`/api/movements/${second.body.movements[0].movement.id}/reverse`)
      .send({ note: 'counted wrong at the door' })
      .expect(201);

    expect(reversal.body.movement.quantity).toBe(-6);
    // The compensating row keeps the link, so it is findable from the order.
    expect(reversal.body.movement.purchaseOrderLineId).toBe(lineId);

    const after = await get(`/api/purchase-orders/${order.id}`).expect(200);
    expect(after.body.status).toBe('partial');
    expect(after.body.lines[0].quantityReceived).toBe(4);
    expect(after.body.lines[0].quantityOutstanding).toBe(6);
    expect(after.body.closedAt).toBeNull();

    // And the ledger and the order still agree about what arrived.
    const stock = await get(`/api/movements/stock/${itemId}`).expect(200);
    expect(stock.body.totalOnHand).toBe(4);
    expect(first.body.purchaseOrder.status).toBe('partial');
  });

  it('takes an order all the way back to sent when every receipt is undone', async () => {
    const supplierId = await makeSupplier('ACME');
    const itemId = await makeItem('PO-UNDO');
    const binId = await makeBin('PO-BIN');
    const order = await sentOrder(supplierId, [{ itemId, quantity: 10 }]);

    const received = await post(`/api/purchase-orders/${order.id}/receive`)
      .send({ locationId: binId, lines: [{ lineId: order.lines[0].id, quantity: 4 }] })
      .expect(201);
    await post(`/api/movements/${received.body.movements[0].movement.id}/reverse`)
      .send({ note: 'wrong order' })
      .expect(201);

    const after = await get(`/api/purchase-orders/${order.id}`).expect(200);
    expect(after.body.status).toBe('sent');
    expect(after.body.lines[0].quantityReceived).toBe(0);
  });

  it('leaves a cancelled order cancelled, but corrects what it says arrived', async () => {
    const supplierId = await makeSupplier('ACME');
    const itemId = await makeItem('PO-CANREV');
    const binId = await makeBin('PO-BIN');
    const order = await sentOrder(supplierId, [{ itemId, quantity: 10 }]);

    const received = await post(`/api/purchase-orders/${order.id}/receive`)
      .send({ locationId: binId, lines: [{ lineId: order.lines[0].id, quantity: 4 }] })
      .expect(201);
    const cancelled = await post(`/api/purchase-orders/${order.id}/cancel`).send({}).expect(200);

    await post(`/api/movements/${received.body.movements[0].movement.id}/reverse`)
      .send({ note: 'never actually arrived' })
      .expect(201);

    const after = await get(`/api/purchase-orders/${order.id}`).expect(200);
    expect(after.body.status).toBe('cancelled');
    expect(after.body.lines[0].quantityReceived).toBe(0);
    expect(after.body.closedAt).toBe(cancelled.body.closedAt);
  });

  it('never lets a line claim a negative received quantity', async () => {
    const supplierId = await makeSupplier('ACME');
    const itemId = await makeItem('PO-FLOOR');
    const binId = await makeBin('PO-BIN');
    const order = await sentOrder(supplierId, [{ itemId, quantity: 10 }]);

    const received = await post(`/api/purchase-orders/${order.id}/receive`)
      .send({ locationId: binId, lines: [{ lineId: order.lines[0].id, quantity: 4 }] })
      .expect(201);
    const movementId = received.body.movements[0].movement.id;

    // Nothing in the ledger refuses a second reversal of the same row today, so
    // the floor in applyReceivedDeltas is what stops it reaching the order.
    await post(`/api/movements/${movementId}/reverse`).send({}).expect(201);
    await post(`/api/movements/${movementId}/reverse`).send({}).expect(201);

    const after = await get(`/api/purchase-orders/${order.id}`).expect(200);
    expect(after.body.lines[0].quantityReceived).toBe(0);
    expect(after.body.status).toBe('sent');
  });
});

describe('finding orders', () => {
  it('filters by status, by open, by supplier and by item', async () => {
    const acme = await makeSupplier('ACME');
    const other = await makeSupplier('BOLT');
    const widget = await makeItem('PO-FIND-1');
    const gasket = await makeItem('PO-FIND-2');

    const draft = await post('/api/purchase-orders')
      .send({ supplierId: acme, lines: [{ itemId: widget, quantity: 1 }] })
      .expect(201);
    const sent = await sentOrder(other, [{ itemId: gasket, quantity: 1 }]);

    const drafts = await get('/api/purchase-orders?status=draft').expect(200);
    expect(drafts.body.data.map((o: { id: string }) => o.id)).toEqual([draft.body.id]);

    const open = await get('/api/purchase-orders?open=true').expect(200);
    expect(open.body.total).toBe(2);

    const bySupplier = await get(`/api/purchase-orders?supplierId=${other}`).expect(200);
    expect(bySupplier.body.data.map((o: { id: string }) => o.id)).toEqual([sent.id]);

    const byItem = await get(`/api/purchase-orders?itemId=${widget}`).expect(200);
    expect(byItem.body.data.map((o: { id: string }) => o.id)).toEqual([draft.body.id]);
  });

  it('searches the number and the supplier recorded on the order', async () => {
    const acme = await makeSupplier('ACME');
    await post('/api/purchase-orders').send({ supplierId: acme }).expect(201);

    const byNumber = await get('/api/purchase-orders?q=PO-00001').expect(200);
    expect(byNumber.body.total).toBe(1);

    const bySupplier = await get('/api/purchase-orders?q=acme').expect(200);
    expect(bySupplier.body.total).toBe(1);

    const miss = await get('/api/purchase-orders?q=nobody').expect(200);
    expect(miss.body.total).toBe(0);
  });

  it('answers 404 for an id that is not one', async () => {
    await get('/api/purchase-orders/not-an-id').expect(404);
    await get(`/api/purchase-orders/${new ObjectId().toHexString()}`).expect(404);
  });

  it('needs a session', async () => {
    await request(app).get('/api/purchase-orders').expect(401);
  });
});
