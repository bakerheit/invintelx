import type { ClientSession, ObjectId } from 'mongodb';
import { derivePurchaseOrderStatus } from '@invintelx/shared';
import { purchaseOrders, type PurchaseOrderDoc } from '../db.js';
import { NotFoundError } from '../errors.js';

/**
 * How much a single delivery — or the reversal of one — changes one line.
 *
 * Signed: a receipt is positive, undoing a receipt is negative. Both go through
 * the same function so that the order cannot end up saying it received stock the
 * ledger no longer holds a row for.
 */
export interface ReceivedDelta {
  lineId: ObjectId;
  quantity: number;
}

/**
 * Apply received quantities to an order and re-derive its status, inside a
 * caller's transaction.
 *
 * This is deliberately a read, a computation and one write rather than a set of
 * `$inc`s. Two reasons. The received quantity has to be floored at zero, which
 * `$inc` cannot express — and a movement can be reversed twice today, since
 * nothing in the ledger refuses that, so the floor is doing real work rather
 * than guarding an impossible case. And the status is a function of *all* the
 * lines, so it has to be computed from the array after the change; having read
 * it back anyway, writing it back whole is both simpler and one round trip
 * cheaper than incrementing and then correcting.
 *
 * Read-then-write is safe here because it runs inside the same transaction as
 * the movements it accompanies: two deliveries against one order at the same
 * instant conflict and one is retried, rather than one overwriting the other.
 * That is the reason this takes a session instead of opening its own.
 */
export async function applyReceivedDeltas(
  purchaseOrderId: ObjectId,
  deltas: readonly ReceivedDelta[],
  session: ClientSession,
  now: Date,
): Promise<PurchaseOrderDoc> {
  const order = await purchaseOrders().findOne({ _id: purchaseOrderId }, { session });
  if (!order) throw new NotFoundError('No purchase order with that id');

  const byLine = new Map(deltas.map((delta) => [delta.lineId.toHexString(), delta.quantity]));
  const lines = order.lines.map((line) => {
    const delta = byLine.get(line._id.toHexString());
    if (delta === undefined) return line;
    return { ...line, quantityReceived: Math.max(0, line.quantityReceived + delta) };
  });

  const status = derivePurchaseOrderStatus(lines, order.status);
  /*
   * A cancellation is a decision somebody took and a reversal does not undo it,
   * so a cancelled order keeps the moment it was cancelled. Anything else is
   * closed exactly while it reads `received`: reversing the receipt that
   * completed an order reopens it, and leaving `closedAt` set would be a lie
   * standing next to a status that no longer agrees with it.
   */
  const closedAt =
    status === 'cancelled'
      ? order.closedAt
      : status === 'received'
        ? (order.closedAt ?? now)
        : null;

  const updated: PurchaseOrderDoc = { ...order, lines, status, closedAt, updatedAt: now };
  await purchaseOrders().updateOne(
    { _id: purchaseOrderId },
    { $set: { lines, status, closedAt, updatedAt: now } },
    { session },
  );

  return updated;
}
