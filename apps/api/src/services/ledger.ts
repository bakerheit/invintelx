import { ObjectId } from 'mongodb';
import { holdsStock, type MovementType } from '@invintelx/shared';
import { getClient, items, locations, movements, stockLevels, type MovementDoc } from '../db.js';
import { BadRequestError, NotFoundError } from '../errors.js';

export interface PostMovementInput {
  itemId: ObjectId;
  locationId: ObjectId;
  /** Signed. Positive adds at the location, negative removes. */
  quantity: number;
  type: MovementType;
  reference: string;
  note: string;
  occurredAt: Date;
  actorId: ObjectId;
  actorName: string;
}

/**
 * The only way a movement is ever written.
 *
 * Everything that changes stock funnels through here so the ledger and its
 * projection can never disagree: both are written inside one transaction, which
 * is the entire reason local Mongo runs as a replica set.
 */
export async function postMovement(
  input: PostMovementInput,
): Promise<{ movement: MovementDoc; balanceAfter: number }> {
  if (input.quantity === 0) {
    throw new BadRequestError('A movement of zero would record nothing', {
      quantity: 'Cannot be zero',
    });
  }

  const [item, location] = await Promise.all([
    items().findOne({ _id: input.itemId }),
    locations().findOne({ _id: input.locationId }),
  ]);

  if (!item) throw new NotFoundError('No item with that id');
  if (!location) throw new NotFoundError('No location with that id');

  if (item.status !== 'active') {
    throw new BadRequestError('That item is archived, so stock cannot move against it', {
      itemId: 'Item is archived',
    });
  }
  if (!location.isActive) {
    throw new BadRequestError('That location is inactive', { locationId: 'Location is inactive' });
  }
  // Only leaves hold stock. Allowing a zone to hold stock as well as its bins
  // would give "how much is in this warehouse" two defensible answers.
  if (!holdsStock(location.type)) {
    throw new BadRequestError(`Stock is held in bins, not in a ${location.type}`, {
      locationId: 'Pick a bin',
    });
  }

  const now = new Date();
  const doc: MovementDoc = {
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
    occurredAt: input.occurredAt,
    actorId: input.actorId,
    actorName: input.actorName,
    createdAt: now,
  };

  let balanceAfter = 0;
  const session = getClient().startSession();
  try {
    await session.withTransaction(async () => {
      await movements().insertOne(doc, { session });
      const updated = await stockLevels().findOneAndUpdate(
        { itemId: item._id, locationId: location._id },
        {
          $inc: { onHand: input.quantity },
          $set: { updatedAt: now, locationCode: location.code },
          $setOnInsert: { _id: new ObjectId(), itemId: item._id, locationId: location._id },
        },
        { upsert: true, returnDocument: 'after', session },
      );
      balanceAfter = updated?.onHand ?? input.quantity;
    });
  } finally {
    await session.endSession();
  }

  return { movement: doc, balanceAfter };
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
