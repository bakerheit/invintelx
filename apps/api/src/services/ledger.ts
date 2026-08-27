import { ObjectId, type ClientSession } from 'mongodb';
import {
  holdsStock,
  isReversible,
  TRANSFER_REVERSAL_MESSAGE,
  type AdjustmentReason,
  type MovementType,
} from '@invintelx/shared';
import {
  getClient,
  items,
  locations,
  movements,
  stockLevels,
  type ItemDoc,
  type LocationDoc,
  type MovementDoc,
} from '../db.js';
import { BadRequestError, NotFoundError } from '../errors.js';
import { applyReceivedDeltas } from './purchaseOrderLines.js';

export interface Actor {
  actorId: ObjectId;
  actorName: string;
}

export interface PostMovementInput extends Actor {
  itemId: ObjectId;
  locationId: ObjectId;
  /** Signed. Positive adds at the location, negative removes. */
  quantity: number;
  type: MovementType;
  reference: string;
  note: string;
  occurredAt: Date;
  groupId?: ObjectId | null;
  reversesId?: ObjectId | null;
  /** Set together, or not at all: a line id without its order is half a link. */
  purchaseOrderId?: ObjectId | null;
  purchaseOrderLineId?: ObjectId | null;
  reason?: AdjustmentReason | null;
}

export interface PostedMovement {
  movement: MovementDoc;
  balanceAfter: number;
}

/**
 * Validate that stock may move for this item at this location.
 *
 * Separate from writing so a transfer can check both of its ends before either
 * is written — refusing halfway through would leave one leg on the books.
 */
async function resolveTarget(
  itemId: ObjectId,
  locationId: ObjectId,
  label = 'location',
): Promise<{ item: ItemDoc; location: LocationDoc }> {
  const [item, location] = await Promise.all([
    items().findOne({ _id: itemId }),
    locations().findOne({ _id: locationId }),
  ]);

  if (!item) throw new NotFoundError('No item with that id');
  if (!location) throw new NotFoundError(`No ${label} with that id`);

  if (item.status !== 'active') {
    throw new BadRequestError('That item is archived, so stock cannot move against it', {
      itemId: 'Item is archived',
    });
  }
  if (!location.isActive) {
    throw new BadRequestError(`That ${label} is inactive`, { [`${label}Id`]: 'Location is inactive' });
  }
  // Only leaves hold stock. Letting a zone hold stock as well as its bins would
  // give "how much is in this warehouse" two defensible answers.
  if (!holdsStock(location.type)) {
    throw new BadRequestError(`Stock is held in bins, not in a ${location.type}`, {
      [`${label}Id`]: 'Pick a bin',
    });
  }

  return { item, location };
}

function buildDoc(
  input: PostMovementInput,
  item: ItemDoc,
  location: LocationDoc,
  now: Date,
): MovementDoc {
  return {
    _id: new ObjectId(),
    itemId: item._id,
    itemSku: item.sku,
    itemName: item.name,
    locationId: location._id,
    locationCode: location.code,
    quantity: input.quantity,
    type: input.type,
    reference: input.reference,
    note: input.note,
    groupId: input.groupId ?? null,
    reversesId: input.reversesId ?? null,
    purchaseOrderId: input.purchaseOrderId ?? null,
    purchaseOrderLineId: input.purchaseOrderLineId ?? null,
    reason: input.reason ?? null,
    occurredAt: input.occurredAt,
    actorId: input.actorId,
    actorName: input.actorName,
    createdAt: now,
  };
}

/**
 * Append one movement and move its projection, inside a caller's transaction.
 *
 * Every write goes through here so the ledger and the projection can never
 * disagree — that is the entire reason local Mongo runs as a replica set.
 */
async function writeInSession(
  doc: MovementDoc,
  session: ClientSession,
  now: Date,
): Promise<number> {
  await movements().insertOne(doc, { session });
  const updated = await stockLevels().findOneAndUpdate(
    { itemId: doc.itemId, locationId: doc.locationId },
    {
      $inc: { onHand: doc.quantity },
      $set: { updatedAt: now, locationCode: doc.locationCode },
      $setOnInsert: { _id: new ObjectId(), itemId: doc.itemId, locationId: doc.locationId },
    },
    { upsert: true, returnDocument: 'after', session },
  );
  return updated?.onHand ?? doc.quantity;
}

function rejectZero(quantity: number): void {
  if (quantity === 0) {
    throw new BadRequestError('A movement of zero would record nothing', {
      quantity: 'Cannot be zero',
    });
  }
}

/**
 * Append one or more movements as a single unit of work.
 *
 * A delivery is why this takes a list. Three lines off one purchase order
 * arriving on one van are three ledger rows and one change to that order, and a
 * failure halfway through would leave the order claiming stock the ledger never
 * took — or the reverse. Every target is resolved before the transaction opens,
 * for the same reason a transfer validates both of its ends first: refusing part
 * way through would leave the earlier rows standing.
 *
 * `alsoInTransaction` runs after the rows are written and before the commit. It
 * exists so that the documents a movement is *about* — today, a purchase order
 * line — can be moved in the same breath as the ledger, without this module
 * having to know what any of them are.
 */
export async function postMovements(
  inputs: readonly PostMovementInput[],
  alsoInTransaction?: (session: ClientSession, now: Date) => Promise<void>,
): Promise<PostedMovement[]> {
  if (inputs.length === 0) {
    throw new BadRequestError('Nothing to post', { _: 'No movements supplied' });
  }
  for (const input of inputs) rejectZero(input.quantity);

  const targets = await Promise.all(
    inputs.map((input) => resolveTarget(input.itemId, input.locationId)),
  );

  const now = new Date();
  const docs = inputs.map((input, index) => {
    const target = targets[index];
    if (!target) throw new NotFoundError('No item with that id');
    return buildDoc(input, target.item, target.location, now);
  });

  const balances: number[] = [];
  const session = getClient().startSession();
  try {
    await session.withTransaction(async () => {
      // withTransaction retries on a transient conflict, so this has to start
      // empty each attempt rather than accumulate one balance per try.
      balances.length = 0;
      for (const doc of docs) {
        balances.push(await writeInSession(doc, session, now));
      }
      if (alsoInTransaction) await alsoInTransaction(session, now);
    });
  } finally {
    await session.endSession();
  }

  return docs.map((movement, index) => ({ movement, balanceAfter: balances[index] ?? 0 }));
}

export async function postMovement(input: PostMovementInput): Promise<PostedMovement> {
  const [posted] = await postMovements([input]);
  if (!posted) throw new Error('postMovements returned nothing for a single input');
  return posted;
}

/**
 * Move stock between two bins as one indivisible pair.
 *
 * Both legs share a groupId and their quantities sum to zero, so total on-hand
 * across the business is unchanged by construction. A half-applied transfer
 * would be stock invented at one end or destroyed at the other, which is why
 * both rows and both projection updates share a single transaction.
 */
export async function postTransfer(input: {
  itemId: ObjectId;
  fromLocationId: ObjectId;
  toLocationId: ObjectId;
  quantity: number;
  reference: string;
  note: string;
  occurredAt: Date;
  actorId: ObjectId;
  actorName: string;
}): Promise<{ out: MovementDoc; in: MovementDoc; fromBalance: number; toBalance: number }> {
  rejectZero(input.quantity);

  // Both ends validated before either is written.
  const [from, to] = await Promise.all([
    resolveTarget(input.itemId, input.fromLocationId, 'fromLocation'),
    resolveTarget(input.itemId, input.toLocationId, 'toLocation'),
  ]);

  const now = new Date();
  const groupId = new ObjectId();
  const shared = {
    itemId: input.itemId,
    type: 'transfer' as const,
    reference: input.reference,
    note: input.note,
    occurredAt: input.occurredAt,
    actorId: input.actorId,
    actorName: input.actorName,
    groupId,
  };

  const outDoc = buildDoc(
    { ...shared, locationId: from.location._id, quantity: -Math.abs(input.quantity) },
    from.item,
    from.location,
    now,
  );
  const inDoc = buildDoc(
    { ...shared, locationId: to.location._id, quantity: Math.abs(input.quantity) },
    to.item,
    to.location,
    now,
  );

  let fromBalance = 0;
  let toBalance = 0;
  const session = getClient().startSession();
  try {
    await session.withTransaction(async () => {
      fromBalance = await writeInSession(outDoc, session, now);
      toBalance = await writeInSession(inDoc, session, now);
    });
  } finally {
    await session.endSession();
  }

  return { out: outDoc, in: inDoc, fromBalance, toBalance };
}

/**
 * Correct a mistake by appending its opposite, never by editing the original.
 *
 * A transfer is refused. Reversing one leg of a pair leaves the other standing,
 * so a 5-unit transfer reversed at the out end reads -5 +5 +5: five units that
 * nobody ever received. The remedy for a wrong transfer is the opposite
 * transfer, which postTransfer writes as a pair.
 */
export async function postReversal(
  movementId: ObjectId,
  note: string,
  actor: Actor,
): Promise<PostedMovement> {
  const original = await movements().findOne({ _id: movementId });
  if (!original) throw new NotFoundError('No movement with that id');

  if (!isReversible(original.type)) {
    throw new BadRequestError(TRANSFER_REVERSAL_MESSAGE, { type: 'Cannot reverse a transfer' });
  }

  /*
   * Undoing a receipt that satisfied a purchase order line has to take that
   * quantity back off the line, in the same transaction as the compensating row.
   * Otherwise the order goes on saying ten arrived while the ledger holds ten
   * and minus ten, and "what is still owed" quietly stops being true.
   *
   * The compensating row keeps the link, so the pair can be found from the order
   * as readily as the original was.
   */
  const line =
    original.purchaseOrderId && original.purchaseOrderLineId
      ? { orderId: original.purchaseOrderId, lineId: original.purchaseOrderLineId }
      : null;

  const [posted] = await postMovements(
    [
      {
        itemId: original.itemId,
        locationId: original.locationId,
        // The opposite of what happened, so the pair sums to zero.
        quantity: -original.quantity,
        type: original.type,
        reference: original.reference,
        note,
        occurredAt: new Date(),
        reversesId: original._id,
        purchaseOrderId: original.purchaseOrderId,
        purchaseOrderLineId: original.purchaseOrderLineId,
        reason: original.reason,
        ...actor,
      },
    ],
    line
      ? async (session, now) => {
          await applyReceivedDeltas(
            line.orderId,
            [{ lineId: line.lineId, quantity: -original.quantity }],
            session,
            now,
          );
        }
      : undefined,
  );

  if (!posted) throw new Error('postMovements returned nothing for a reversal');
  return posted;
}

/**
 * On-hand for one item, by location and in total.
 *
 * Reads the projection rather than summing the ledger, because this is on the
 * path of every item page and the ledger grows without bound.
 */
export async function stockForItem(itemId: ObjectId) {
  const levels = await stockLevels().find({ itemId }).sort({ locationCode: 1 }).toArray();
  return {
    levels,
    total: levels.reduce((sum, level) => sum + level.onHand, 0),
  };
}
