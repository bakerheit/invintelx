import { describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import { isLineComplete } from '@invintelx/shared';
import {
  SEED_PURCHASE_ORDERS,
  buildPurchaseOrders,
  type SeedPurchaseOrder,
} from './seedPurchaseOrders.js';
import type { ItemDoc, LocationDoc, SupplierDoc, SupplierItemDoc } from './db.js';

/*
 * The seed itself cannot be run from a test - `seed.ts` calls `main()` at import
 * time and would write to whatever database the environment pointed at. These
 * cover the part that decides what the demo data says, which is the part that
 * can be wrong in a way nobody notices until a reader believes it.
 */

const NOW = new Date('2026-06-15T09:00:00.000Z');
const ACTOR = new ObjectId();

function makeItem(sku: string, reorderQuantity: number, unitCostCents: number): ItemDoc {
  return {
    _id: new ObjectId(),
    sku,
    name: `Item ${sku}`,
    description: '',
    category: 'Fasteners',
    unitOfMeasure: 'each',
    barcode: '',
    unitCostCents,
    unitPriceCents: unitCostCents * 2,
    reorderPoint: 10,
    reorderQuantity,
    status: 'active',
    attributes: {},
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeSupplier(code: string, promisedLeadTimeDays: number): SupplierDoc {
  return {
    _id: new ObjectId(),
    code,
    name: `${code} Ltd`,
    status: 'active',
    contact: { name: '', email: '', phone: '', website: '', address: '' },
    paymentTerms: 'net_30',
    currency: 'USD',
    promisedLeadTimeDays,
    notes: '',
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeSupply(supplier: SupplierDoc, item: ItemDoc, unitPriceCents: number): SupplierItemDoc {
  return {
    _id: new ObjectId(),
    supplierId: supplier._id,
    itemId: item._id,
    supplierSku: `${supplier.code}-${item.sku}`,
    priceBreaks: [{ minQuantity: 1, unitPriceCents }],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

const BIN: LocationDoc = {
  _id: new ObjectId(),
  code: 'A-01-01',
  name: 'Bin',
  type: 'bin',
  parentId: new ObjectId(),
  path: [],
  pathLabel: 'SITE / ZONE / A-01-01',
  isActive: true,
  createdAt: NOW,
  updatedAt: NOW,
};

/** One supplier, three items it carries, priced below our own cost. */
function fixture() {
  const supplier = makeSupplier('FIXFAST', 7);
  const itemDocs = [makeItem('A', 100, 500), makeItem('B', 40, 250), makeItem('C', 8, 900)];
  const supplyLines = itemDocs.map((item, index) => makeSupply(supplier, item, 400 + index));
  return { supplier, itemDocs, supplyLines };
}

function build(specs: SeedPurchaseOrder[]) {
  const { supplier, itemDocs, supplyLines } = fixture();
  return buildPurchaseOrders(
    specs,
    [supplier],
    supplyLines,
    itemDocs,
    BIN,
    ACTOR,
    'Demo Admin',
    NOW,
  );
}

const BASE: SeedPurchaseOrder = {
  supplierCode: 'FIXFAST',
  lineCount: 3,
  expectedInDays: 7,
  receivedFractions: [],
  raisedAs: 'sent',
  reference: '',
  note: '',
};

describe('building the demo purchase orders', () => {
  it('leaves an order nothing has arrived against as sent', () => {
    const { orders, receipts } = build([BASE]);
    expect(orders).toHaveLength(1);
    expect(orders[0]?.status).toBe('sent');
    expect(receipts).toHaveLength(0);
  });

  it('lands a short delivery on partial and a complete one on received', () => {
    const { orders } = build([
      { ...BASE, expectedInDays: -3, receivedFractions: [1, 0.4] },
      { ...BASE, expectedInDays: -3, lineCount: 2, receivedFractions: [1, 1] },
    ]);
    expect(orders[0]?.status).toBe('partial');
    expect(orders[1]?.status).toBe('received');
  });

  it('never moves a draft or a cancelled order with a quantity', () => {
    const { orders } = build([
      { ...BASE, raisedAs: 'draft', receivedFractions: [1, 1, 1] },
      { ...BASE, raisedAs: 'cancelled', receivedFractions: [1, 1, 1] },
    ]);
    expect(orders[0]?.status).toBe('draft');
    expect(orders[1]?.status).toBe('cancelled');
  });

  it('writes one receipt per line that turned up, joined to its order and line', () => {
    const { orders, receipts } = build([
      { ...BASE, expectedInDays: -3, receivedFractions: [1, 0.4] },
    ]);
    const order = orders[0];
    expect(order).toBeDefined();
    if (!order) return;

    expect(receipts).toHaveLength(2);
    receipts.forEach((movement) => {
      expect(movement.type).toBe('receipt');
      expect(movement.quantity).toBeGreaterThan(0);
      expect(movement.purchaseOrderId?.equals(order._id)).toBe(true);
      expect(order.lines.some((line) => line._id.equals(movement.purchaseOrderLineId!))).toBe(true);
    });
  });

  it('keeps every line quantity and every receipt in step', () => {
    const { orders, receipts } = build([
      { ...BASE, expectedInDays: -3, receivedFractions: [1, 0.4] },
    ]);
    const order = orders[0];
    if (!order) throw new Error('no order');

    order.lines.forEach((line) => {
      const posted = receipts
        .filter((movement) => movement.purchaseOrderLineId?.equals(line._id))
        .reduce((sum, movement) => sum + movement.quantity, 0);
      expect(posted).toBe(line.quantityReceived);
    });
  });

  it('prices each line off the supplier ladder rather than our own cost', () => {
    const { orders } = build([BASE]);
    // 400, 401, 402 from the fixture; our own costs are 500, 250 and 900.
    expect(orders[0]?.lines.map((line) => line.unitCostCents)).toEqual([400, 401, 402]);
  });

  it('falls back to our cost when the ladder does not reach that quantity', () => {
    const supplier = makeSupplier('FIXFAST', 7);
    const item = makeItem('A', 5, 777);
    const supply = makeSupply(supplier, item, 400);
    // Quoted from 50 up, and we are buying five.
    supply.priceBreaks = [{ minQuantity: 50, unitPriceCents: 400 }];

    const { orders } = buildPurchaseOrders(
      [{ ...BASE, lineCount: 1 }],
      [supplier],
      [supply],
      [item],
      BIN,
      ACTOR,
      'Demo Admin',
      NOW,
    );
    expect(orders[0]?.lines[0]?.unitCostCents).toBe(777);
  });

  it('dates a delivery no later than today, whatever the order promised', () => {
    const { receipts } = build([{ ...BASE, expectedInDays: 30, receivedFractions: [1] }]);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.occurredAt.getTime()).toBeLessThanOrEqual(NOW.getTime());
  });

  it('numbers the orders from one, in order, with no gaps', () => {
    const { orders } = build([BASE, BASE, BASE]);
    expect(orders.map((order) => order.number)).toEqual(['PO-00001', 'PO-00002', 'PO-00003']);
  });

  it('closes only the orders that are actually finished', () => {
    const { orders } = build([
      { ...BASE, expectedInDays: -3, lineCount: 2, receivedFractions: [1, 1] },
      { ...BASE, raisedAs: 'cancelled' },
      BASE,
    ]);
    expect(orders[0]?.closedAt).not.toBeNull();
    expect(orders[1]?.closedAt).not.toBeNull();
    expect(orders[2]?.closedAt).toBeNull();
  });

  it('gives a draft no sent date and everything else one before the promise', () => {
    const { orders } = build([{ ...BASE, raisedAs: 'draft' }, BASE]);
    expect(orders[0]?.sentAt).toBeNull();
    const sent = orders[1];
    if (!sent?.sentAt) throw new Error('expected a sent date');
    expect(sent.sentAt.getTime()).toBeLessThan(sent.expectedDate!.getTime());
  });

  it('skips a spec naming a supplier that is not in the dataset', () => {
    const { orders } = build([{ ...BASE, supplierCode: 'NOBODY' }, BASE]);
    expect(orders).toHaveLength(1);
    expect(orders[0]?.supplierCode).toBe('FIXFAST');
  });

  it('takes no more lines than the supplier actually carries', () => {
    const { orders } = build([{ ...BASE, lineCount: 99 }]);
    expect(orders[0]?.lines).toHaveLength(3);
  });
});

/**
 * The specification that actually ships, built against a stand-in catalogue.
 *
 * Asserted on the built documents rather than on the table, because the table
 * says what was asked for and the documents say what a reader will see - and
 * `derivePurchaseOrderStatus` sits between the two.
 */
function buildShipped() {
  const supplierDocs = SEED_PURCHASE_ORDERS.map((spec, index) =>
    makeSupplier(spec.supplierCode, 7 + index),
  );
  const itemDocs: ItemDoc[] = [];
  const supplyLines: SupplierItemDoc[] = [];
  supplierDocs.forEach((supplier) => {
    for (let n = 0; n < 4; n += 1) {
      const item = makeItem(`${supplier.code}-${n}`, 20 + n, 300 + n);
      itemDocs.push(item);
      supplyLines.push(makeSupply(supplier, item, 250 + n));
    }
  });
  return buildPurchaseOrders(
    SEED_PURCHASE_ORDERS,
    supplierDocs,
    supplyLines,
    itemDocs,
    BIN,
    ACTOR,
    'Demo Admin',
    NOW,
  );
}

describe('the shipped demo specification', () => {
  it('produces every status a reader needs to see', () => {
    const { orders } = buildShipped();
    expect(orders).toHaveLength(SEED_PURCHASE_ORDERS.length);
    expect(new Set(orders.map((order) => order.status))).toEqual(
      new Set(['draft', 'sent', 'partial', 'received', 'cancelled']),
    );
  });

  it('has at least one order whose promised date has already passed', () => {
    const { orders } = buildShipped();
    expect(orders.some((order) => order.expectedDate! < NOW)).toBe(true);
  });

  it('leaves the partial order with something still outstanding on it', () => {
    const { orders } = buildShipped();
    const partial = orders.find((order) => order.status === 'partial');
    if (!partial) throw new Error('the demo data no longer contains a partial order');
    expect(partial.lines.some((line) => line.quantityReceived > 0)).toBe(true);
    expect(partial.lines.some((line) => !isLineComplete(line))).toBe(true);
  });

  it('posts a receipt for every quantity the orders claim, and no others', () => {
    const { orders, receipts } = buildShipped();
    const claimed = orders.flatMap((order) => order.lines).filter((line) => line.quantityReceived > 0);
    expect(receipts).toHaveLength(claimed.length);
    expect(receipts.reduce((sum, movement) => sum + movement.quantity, 0)).toBe(
      claimed.reduce((sum, line) => sum + line.quantityReceived, 0),
    );
  });

  it('gives every order its own number', () => {
    const { orders } = buildShipped();
    expect(new Set(orders.map((order) => order.number)).size).toBe(orders.length);
  });

  it('agrees with the shared completeness rule about what a full line is', () => {
    // Guards the fixtures above against `isLineComplete` changing underneath
    // them: a fraction of 1 has to mean "this line is done".
    expect(isLineComplete({ quantityOrdered: 40, quantityReceived: 40 })).toBe(true);
    expect(isLineComplete({ quantityOrdered: 40, quantityReceived: 16 })).toBe(false);
  });
});
