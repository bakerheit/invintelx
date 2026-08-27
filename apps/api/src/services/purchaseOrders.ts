import { ObjectId, type Collection } from 'mongodb';
import {
  canCancel,
  canEditLines,
  canReceive,
  canSend,
  formatPurchaseOrderNumber,
  type CreatePurchaseOrderInput,
  type PurchaseOrderLineInput,
  type PurchaseOrderStatus,
  type ReceivePurchaseOrderInput,
  type UpdatePurchaseOrderInput,
} from '@invintelx/shared';
import {
  PURCHASE_ORDER_NUMBER_COUNTER,
  counters,
  getDb,
  items,
  purchaseOrders,
  type PurchaseOrderDoc,
  type PurchaseOrderLineDoc,
} from '../db.js';
import { BadRequestError, NotFoundError } from '../errors.js';
import { applyReceivedDeltas, type ReceivedDelta } from './purchaseOrderLines.js';
import { postMovements, type Actor, type PostedMovement } from './ledger.js';

/**
 * The part of a supplier a purchase order needs: that it exists, that it is
 * still one you buy from, and what to write on the order.
 *
 * The suppliers collection belongs to INVX-25, which is not merged yet. Naming
 * only the four fields this ticket reads keeps that model in one place rather
 * than half-copied here, and means the full `SupplierDoc` arriving alongside it
 * adds fields to a document this already reads correctly.
 */
interface SupplierRef {
  _id: ObjectId;
  code: string;
  name: string;
  status: 'active' | 'archived';
}

const supplierRefs = (): Collection<SupplierRef> => getDb().collection<SupplierRef>('suppliers');

/**
 * Take the next order number.
 *
 * Atomic by construction: the `$inc` is the allocation, so two orders created in
 * the same millisecond get different numbers without anybody holding a lock.
 * `upsert` means the first order on a fresh instance is PO-00001 rather than an
 * error about a counter nobody seeded.
 */
async function nextPurchaseOrderNumber(): Promise<string> {
  const counter = await counters().findOneAndUpdate(
    { _id: PURCHASE_ORDER_NUMBER_COUNTER },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' },
  );
  return formatPurchaseOrderNumber(counter?.seq ?? 1);
}

async function resolveSupplier(supplierId: ObjectId): Promise<SupplierRef> {
  const supplier = await supplierRefs().findOne({ _id: supplierId });
  if (!supplier) throw new NotFoundError('No supplier with that id');
  if (supplier.status === 'archived') {
    throw new BadRequestError('That supplier is archived, so nothing can be ordered from them', {
      supplierId: 'Supplier is archived',
    });
  }
  return supplier;
}

/**
 * Turn line inputs into line documents, resolving each item once.
 *
 * Every item is checked before any line is built, so an order with a bad third
 * line is refused whole rather than half-written — the same reason a transfer
 * validates both of its ends before writing either.
 */
async function buildLines(
  inputs: readonly PurchaseOrderLineInput[],
): Promise<PurchaseOrderLineDoc[]> {
  const ids = inputs.map((line) => new ObjectId(line.itemId));
  const found = await items()
    .find({ _id: { $in: ids } })
    .toArray();
  const byId = new Map(found.map((item) => [item._id.toHexString(), item]));

  return inputs.map((line, index) => {
    const item = byId.get(line.itemId);
    if (!item) {
      throw new BadRequestError('No item with that id', {
        [`lines.${index}.itemId`]: 'Unknown item',
      });
    }
    if (item.status !== 'active') {
      throw new BadRequestError(`${item.sku} is archived, so it cannot be ordered`, {
        [`lines.${index}.itemId`]: 'Item is archived',
      });
    }
    return {
      _id: new ObjectId(),
      itemId: item._id,
      itemSku: item.sku,
      itemName: item.name,
      quantityOrdered: line.quantity,
      quantityReceived: 0,
      unitCostCents: line.unitCostCents,
    };
  });
}

export async function getPurchaseOrder(id: ObjectId): Promise<PurchaseOrderDoc> {
  const order = await purchaseOrders().findOne({ _id: id });
  if (!order) throw new NotFoundError('No purchase order with that id');
  return order;
}

export async function createPurchaseOrder(
  input: CreatePurchaseOrderInput,
): Promise<PurchaseOrderDoc> {
  const supplier = await resolveSupplier(new ObjectId(input.supplierId));
  const lines = await buildLines(input.lines);

  // Taken last, after everything that could refuse the order has had its say, so
  // a rejected request does not burn a number.
  const number = await nextPurchaseOrderNumber();

  const now = new Date();
  const doc: PurchaseOrderDoc = {
    _id: new ObjectId(),
    number,
    supplierId: supplier._id,
    supplierCode: supplier.code,
    supplierName: supplier.name,
    status: 'draft',
    expectedDate: input.expectedDate ? new Date(input.expectedDate) : null,
    reference: input.reference,
    note: input.note,
    lines,
    sentAt: null,
    closedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  await purchaseOrders().insertOne(doc);
  return doc;
}

/**
 * Edit an order.
 *
 * What may change depends on where it is. The lines are the order as far as the
 * supplier is concerned, so once it has been sent they are frozen — changing
 * them here would make our copy disagree with theirs silently. The expected date
 * and the notes stay editable for as long as the order is open, because a
 * slipped delivery date is the single most ordinary thing that happens to a
 * purchase order and the alternative is cancelling and re-raising it.
 */
export async function updatePurchaseOrder(
  id: ObjectId,
  input: UpdatePurchaseOrderInput,
): Promise<PurchaseOrderDoc> {
  const order = await getPurchaseOrder(id);
  if (order.status === 'received' || order.status === 'cancelled') {
    throw new BadRequestError(`A ${order.status} purchase order cannot be edited`, {
      status: `Order is ${order.status}`,
    });
  }

  const changes: Partial<PurchaseOrderDoc> = {};

  if (input.lines !== undefined) {
    if (!canEditLines(order.status)) {
      throw new BadRequestError(
        'This order has been sent, so its lines are fixed. Cancel it and raise another if the order itself has changed.',
        { lines: `Order is ${order.status}` },
      );
    }
    changes.lines = await buildLines(input.lines);
  }
  if (input.supplierId !== undefined) {
    if (!canEditLines(order.status)) {
      throw new BadRequestError('This order has been sent, so its supplier is fixed', {
        supplierId: `Order is ${order.status}`,
      });
    }
    const supplier = await resolveSupplier(new ObjectId(input.supplierId));
    changes.supplierId = supplier._id;
    changes.supplierCode = supplier.code;
    changes.supplierName = supplier.name;
  }
  if (input.expectedDate !== undefined) {
    changes.expectedDate = input.expectedDate ? new Date(input.expectedDate) : null;
  }
  if (input.reference !== undefined) changes.reference = input.reference;
  if (input.note !== undefined) changes.note = input.note;

  changes.updatedAt = new Date();
  const updated = await purchaseOrders().findOneAndUpdate(
    { _id: id },
    { $set: changes },
    { returnDocument: 'after' },
  );
  if (!updated) throw new NotFoundError('No purchase order with that id');
  return updated;
}

/** Send it to the supplier. An order with no lines asks them for nothing. */
export async function sendPurchaseOrder(id: ObjectId): Promise<PurchaseOrderDoc> {
  const order = await getPurchaseOrder(id);
  if (!canSend(order.status)) {
    throw new BadRequestError(`Only a draft can be sent, and this one is ${order.status}`, {
      status: `Order is ${order.status}`,
    });
  }
  if (order.lines.length === 0) {
    throw new BadRequestError('Add at least one line before sending this order', {
      lines: 'Order has no lines',
    });
  }

  const now = new Date();
  const updated = await purchaseOrders().findOneAndUpdate(
    { _id: id, status: 'draft' },
    { $set: { status: 'sent' as PurchaseOrderStatus, sentAt: now, updatedAt: now } },
    { returnDocument: 'after' },
  );
  if (!updated) throw new NotFoundError('No purchase order with that id');
  return updated;
}

/**
 * Close an order that will not be completed.
 *
 * Whatever has already been received stays on the ledger and stays on the lines.
 * Cancelling is a statement about the rest of the order, not a claim that the
 * stock which turned up did not.
 */
export async function cancelPurchaseOrder(id: ObjectId): Promise<PurchaseOrderDoc> {
  const order = await getPurchaseOrder(id);
  if (!canCancel(order.status)) {
    throw new BadRequestError(`A ${order.status} purchase order cannot be cancelled`, {
      status: `Order is ${order.status}`,
    });
  }

  const now = new Date();
  const updated = await purchaseOrders().findOneAndUpdate(
    { _id: id },
    { $set: { status: 'cancelled' as PurchaseOrderStatus, closedAt: now, updatedAt: now } },
    { returnDocument: 'after' },
  );
  if (!updated) throw new NotFoundError('No purchase order with that id');
  return updated;
}

/**
 * Why an order in this state will not take a delivery, said in terms of what the
 * person holding the goods should do instead. Every one of these has a next step
 * — a refusal that only says no leaves the stock unrecorded.
 */
const REFUSED_RECEIPT_REASONS: Partial<Record<PurchaseOrderStatus, string>> = {
  draft:
    'This order has not been sent yet. Send it first, or post a plain receipt if the stock arrived unordered.',
  received:
    'This order is already fully received. If more stock arrived against it, post a plain receipt so the extra is on the ledger.',
  cancelled:
    'This order was cancelled. Post a plain receipt if the stock arrived anyway, so the ledger has it.',
};

function refuseReceipt(status: PurchaseOrderStatus): never {
  throw new BadRequestError(
    REFUSED_RECEIPT_REASONS[status] ?? `Nothing can be received against a ${status} order`,
    { status: `Order is ${status}` },
  );
}

/**
 * Record a delivery against an order: one receipt movement per line that turned
 * up, and the order advanced to match.
 *
 * Partial delivery needs no special case. You name the lines that arrived and
 * the quantities that arrived; the status is then re-derived from every line, so
 * a short shipment lands on `partial` and the last box that completes the order
 * lands on `received` without either being asked for.
 *
 * All of it is one transaction. A delivery that wrote two of its three ledger
 * rows, or that moved the stock without moving the order, is worse than one that
 * was refused outright and retyped.
 */
export async function receivePurchaseOrder(
  id: ObjectId,
  input: ReceivePurchaseOrderInput,
  actor: Actor,
): Promise<{ purchaseOrder: PurchaseOrderDoc; movements: PostedMovement[] }> {
  const order = await getPurchaseOrder(id);
  if (!canReceive(order.status)) refuseReceipt(order.status);

  const byId = new Map(order.lines.map((line) => [line._id.toHexString(), line]));
  const received = input.lines.map((entry, index) => {
    const line = byId.get(entry.lineId);
    if (!line) {
      throw new BadRequestError(`No line ${entry.lineId} on ${order.number}`, {
        [`lines.${index}.lineId`]: 'Not a line on this order',
      });
    }
    return { line, quantity: entry.quantity };
  });

  const occurredAt = input.occurredAt ? new Date(input.occurredAt) : new Date();
  const locationId = new ObjectId(input.locationId);
  const deltas: ReceivedDelta[] = received.map(({ line, quantity }) => ({
    lineId: line._id,
    quantity,
  }));

  let updated: PurchaseOrderDoc | undefined;
  const posted = await postMovements(
    received.map(({ line, quantity }) => ({
      itemId: line.itemId,
      locationId,
      quantity,
      type: 'receipt' as const,
      // The order number, so a person reading the ledger sees where this came
      // from without following the id. The link that a query uses is below.
      reference: order.number,
      note: input.note,
      occurredAt,
      purchaseOrderId: order._id,
      purchaseOrderLineId: line._id,
      ...actor,
    })),
    async (session, now) => {
      updated = await applyReceivedDeltas(order._id, deltas, session, now);
    },
  );

  if (!updated) throw new Error('the delivery committed without updating its purchase order');
  return { purchaseOrder: updated, movements: posted };
}
