/**
 * The purchase-order half of the demo dataset.
 *
 * Its own module rather than another section of `seed.ts` because `seed.ts`
 * calls `main()` at import time - importing it from a test would seed whatever
 * database the environment happened to point at. Pure functions over documents
 * that are already in memory can be tested without any of that.
 */
import { ObjectId } from 'mongodb';
import {
  derivePurchaseOrderStatus,
  formatPurchaseOrderNumber,
  priceForQuantity,
  type PurchaseOrderStatus,
} from '@invintelx/shared';
import type {
  ItemDoc,
  LocationDoc,
  MovementDoc,
  PurchaseOrderDoc,
  PurchaseOrderLineDoc,
  SupplierDoc,
  SupplierItemDoc,
} from './db.js';

/**
 * One demo purchase order, written as the situation it is meant to show rather
 * than as a document.
 *
 * `receivedFractions` is per line and in line order, so `[1, 0.4]` is "the first
 * line turned up whole, the second turned up short, and anything after it has
 * not turned up at all" - which is the case this feature exists for and the one
 * a screenshot has to contain.
 */
export interface SeedPurchaseOrder {
  supplierCode: string;
  /** How many of that supplier's catalogue lines to put on the order. */
  lineCount: number;
  /** Signed days from now. Negative is a date that has already passed. */
  expectedInDays: number;
  receivedFractions: number[];
  /** Where the order got to by hand. What deliveries made of it is derived. */
  raisedAs: Extract<PurchaseOrderStatus, 'draft' | 'sent' | 'cancelled'>;
  reference: string;
  note: string;
}

/**
 * Five orders, one per thing a reader needs to see: a draft still being typed,
 * an order out with the supplier, a late one that came up short, a completed
 * one, and a cancelled one. Nothing here draws from the seed's `random`, so
 * adding or removing an order cannot shift the ledger beneath it.
 */
export const SEED_PURCHASE_ORDERS: SeedPurchaseOrder[] = [
  {
    supplierCode: 'FIXFAST',
    lineCount: 3,
    expectedInDays: 21,
    receivedFractions: [],
    raisedAs: 'draft',
    reference: '',
    note: 'Waiting on the site foreman to confirm quantities.',
  },
  {
    supplierCode: 'VOLTEC',
    lineCount: 4,
    expectedInDays: 12,
    receivedFractions: [],
    raisedAs: 'sent',
    reference: 'REQ-4471',
    note: '',
  },
  {
    // Late and short: the two things at once, because that is how they arrive.
    supplierCode: 'AQUALINE',
    lineCount: 3,
    expectedInDays: -3,
    receivedFractions: [1, 0.4],
    raisedAs: 'sent',
    reference: 'REQ-4468',
    note: 'Driver said the rest is on next week’s run.',
  },
  {
    supplierCode: 'TIMBERCO',
    lineCount: 2,
    expectedInDays: -11,
    receivedFractions: [1, 1],
    raisedAs: 'sent',
    reference: 'REQ-4455',
    note: '',
  },
  {
    supplierCode: 'BROADSTOCK',
    lineCount: 2,
    expectedInDays: 6,
    receivedFractions: [],
    raisedAs: 'cancelled',
    reference: 'REQ-4472',
    note: 'Raised against the wrong site. Re-raised on FIXFAST.',
  },
];

function shiftDays(from: Date, days: number): Date {
  const out = new Date(from);
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}

export interface SeededPurchasing {
  orders: PurchaseOrderDoc[];
  /** Receipt movements for what actually turned up, to go in with the ledger. */
  receipts: MovementDoc[];
}

/**
 * Build the demo orders and the receipt movements that go with them.
 *
 * The two are returned together, and the caller inserts them together, on
 * purpose: a seeded order claiming a delivery the ledger never saw would teach
 * the reader exactly the wrong thing about a product whose whole argument is
 * that the order and the ledger cannot disagree.
 *
 * Status is derived by the same `derivePurchaseOrderStatus` the API uses rather
 * than written down here, so the seed cannot mint a state the API would never
 * produce - a demo database that is a counterexample to the code is worse than
 * no demo database.
 */
export function buildPurchaseOrders(
  specs: readonly SeedPurchaseOrder[],
  supplierDocs: readonly SupplierDoc[],
  supplyLines: readonly SupplierItemDoc[],
  itemDocs: readonly ItemDoc[],
  bin: LocationDoc,
  actorId: ObjectId,
  actorName: string,
  now: Date,
): SeededPurchasing {
  const itemById = new Map(itemDocs.map((item) => [item._id.toHexString(), item]));
  const orders: PurchaseOrderDoc[] = [];
  const receipts: MovementDoc[] = [];

  specs.forEach((spec, orderIndex) => {
    const supplier = supplierDocs.find((doc) => doc.code === spec.supplierCode);
    if (!supplier) return;

    const carried = supplyLines
      .filter((line) => line.supplierId.equals(supplier._id))
      .slice(0, spec.lineCount);
    if (carried.length === 0) return;

    const expectedDate = shiftDays(now, spec.expectedInDays);
    // Placed a lead time before it was promised, which is what a supplier who
    // keeps their word looks like in the data.
    const sentAt =
      spec.raisedAs === 'draft' ? null : shiftDays(expectedDate, -supplier.promisedLeadTimeDays);

    const lines: PurchaseOrderLineDoc[] = [];
    carried.forEach((supply, lineIndex) => {
      const item = itemById.get(supply.itemId.toHexString());
      if (!item) return;

      const quantityOrdered = item.reorderQuantity;
      const fraction = spec.receivedFractions[lineIndex] ?? 0;
      const quantityReceived = Math.round(quantityOrdered * fraction);
      lines.push({
        _id: new ObjectId(),
        itemId: item._id,
        itemSku: item.sku,
        itemName: item.name,
        quantityOrdered,
        quantityReceived,
        /*
         * Their ladder, at the quantity actually being bought. When the ladder
         * does not reach down to that quantity `priceForQuantity` answers null,
         * which is a real answer rather than a missing one - so the line falls
         * back to our own cost instead of inventing a price they never quoted.
         */
        unitCostCents: priceForQuantity(supply.priceBreaks, quantityOrdered) ?? item.unitCostCents,
      });
    });
    if (lines.length === 0) return;

    const status = derivePurchaseOrderStatus(lines, spec.raisedAs);
    const number = formatPurchaseOrderNumber(orderIndex + 1);
    const orderId = new ObjectId();
    // Dated when it was promised, or now if that is still ahead: a delivery in
    // the future is not a delivery.
    const deliveredAt = expectedDate < now ? expectedDate : now;

    lines.forEach((line) => {
      if (line.quantityReceived <= 0) return;
      receipts.push({
        _id: new ObjectId(),
        itemId: line.itemId,
        itemSku: line.itemSku,
        itemName: line.itemName,
        locationId: bin._id,
        locationCode: bin.code,
        quantity: line.quantityReceived,
        type: 'receipt',
        reference: number,
        note: '',
        groupId: null,
        reversesId: null,
        /*
         * The join the API writes, written here too. A demo where the receipt
         * only mentions the order number in a string would not survive the first
         * person who tries to query "what satisfied this line".
         */
        purchaseOrderId: orderId,
        purchaseOrderLineId: line._id,
        reason: null,
        occurredAt: deliveredAt,
        actorId,
        actorName,
        createdAt: deliveredAt,
      });
    });

    orders.push({
      _id: orderId,
      number,
      supplierId: supplier._id,
      supplierCode: supplier.code,
      supplierName: supplier.name,
      status,
      expectedDate,
      reference: spec.reference,
      note: spec.note,
      lines,
      sentAt,
      closedAt: status === 'received' ? deliveredAt : status === 'cancelled' ? now : null,
      createdAt: sentAt ?? now,
      updatedAt: now,
    });
  });

  return { orders, receipts };
}
