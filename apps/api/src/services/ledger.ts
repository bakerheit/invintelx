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
  reason?: AdjustmentReason | null;
}

/**
 * Whether a location may hold stock at all.
 *
 * Split out from `resolveTarget` because a cycle count picks a bin before it
 * knows a single item, and the bin has to be judged by exactly the same rules
 * the eventual adjustments will be judged by — otherwise a sheet can be opened
 * against a bin whose every variance would then be refused.
 */
export function assertStockLocation(location: LocationDoc, label = 'location'): void {
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
}

function assertStockItem(item: ItemDoc): void {
  if (item.status !== 'active') {
    throw new BadRequestError('That item is archived, so stock cannot move against it', {
      itemId: 'Item is archived',
    });
  }
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

  assertStockItem(item);
  assertStockLocation(location, label);

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

export async function postMovement(
  input: PostMovementInput,
): Promise<{ movement: MovementDoc; balanceAfter: number }> {
  rejectZero(input.quantity);
  const { item, location } = await resolveTarget(input.itemId, input.locationId);

  const now = new Date();
  const doc = buildDoc(input, item, location, now);

  let balanceAfter = 0;
  const session = getClient().startSession();
  try {
    await session.withTransaction(async () => {
      balanceAfter = await writeInSession(doc, session, now);
    });
  } finally {
    await session.endSession();
  }

  return { movement: doc, balanceAfter };
}

/**
 * Validate a batch of movements and build every row, writing nothing.
 *
 * The same "check everything before writing anything" rule a transfer follows,
 * widened to a whole count sheet: a sheet of thirty accepted variances that
 * refuses on the twenty-ninth must leave the ledger exactly as it found it, and
 * the only way to be sure of that is to have written none of them yet. The
 * lookups are batched because a count sheet is one bin and many items, and
 * resolving each line on its own would be two queries per line.
 *
 * The ids are minted here, so a caller can record what it is about to write
 * against something else in the same transaction.
 */
export async function prepareMovements(
  inputs: PostMovementInput[],
  now: Date,
): Promise<MovementDoc[]> {
  if (inputs.length === 0) return [];
  for (const input of inputs) rejectZero(input.quantity);

  const itemIds = [...new Map(inputs.map((i) => [i.itemId.toHexString(), i.itemId])).values()];
  const locationIds = [
    ...new Map(inputs.map((i) => [i.locationId.toHexString(), i.locationId])).values(),
  ];

  const [itemDocs, locationDocs] = await Promise.all([
    items()
      .find({ _id: { $in: itemIds } })
      .toArray(),
    locations()
      .find({ _id: { $in: locationIds } })
      .toArray(),
  ]);

  const itemsById = new Map(itemDocs.map((doc) => [doc._id.toHexString(), doc]));
  const locationsById = new Map(locationDocs.map((doc) => [doc._id.toHexString(), doc]));

  return inputs.map((input) => {
    const item = itemsById.get(input.itemId.toHexString());
    if (!item) throw new NotFoundError('No item with that id');
    const location = locationsById.get(input.locationId.toHexString());
    if (!location) throw new NotFoundError('No location with that id');

    assertStockItem(item);
    assertStockLocation(location);

    return buildDoc(input, item, location, now);
  });
}

/**
 * Append prepared movements inside a caller's transaction, in order.
 *
 * Exposed so that a write which has to be atomic with something outside the
 * ledger — accepting a count sheet, which must never be able to post twice —
 * can put both in one unit of work. Returns each row's balance after, in the
 * order the rows were given.
 */
export async function writeMovements(
  docs: MovementDoc[],
  session: ClientSession,
  now: Date,
): Promise<number[]> {
  const balances: number[] = [];
  for (const doc of docs) {
    balances.push(await writeInSession(doc, session, now));
  }
  return balances;
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
): Promise<{ movement: MovementDoc; balanceAfter: number }> {
  const original = await movements().findOne({ _id: movementId });
  if (!original) throw new NotFoundError('No movement with that id');

  if (!isReversible(original.type)) {
    throw new BadRequestError(TRANSFER_REVERSAL_MESSAGE, { type: 'Cannot reverse a transfer' });
  }

  return postMovement({
    itemId: original.itemId,
    locationId: original.locationId,
    // The opposite of what happened, so the pair sums to zero.
    quantity: -original.quantity,
    type: original.type,
    reference: original.reference,
    note,
    occurredAt: new Date(),
    reversesId: original._id,
    reason: original.reason,
    ...actor,
  });
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
