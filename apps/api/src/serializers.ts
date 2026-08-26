import type { Item, Location, Movement, PublicUser, StockLevel } from '@invintelx/shared';
import type { ItemDoc, LocationDoc, MovementDoc, StockLevelDoc, UserDoc } from './db.js';

/**
 * Documents never go to the client directly. Going through an explicit mapper
 * means adding a sensitive field to a document cannot silently leak it - the
 * password hash has to be typed out here to escape, and it never is.
 */
export function toPublicUser(doc: UserDoc): PublicUser {
  return {
    id: doc._id.toHexString(),
    email: doc.email,
    name: doc.name,
    role: doc.role,
    createdAt: doc.createdAt.toISOString(),
  };
}

export function toItem(doc: ItemDoc): Item {
  return {
    id: doc._id.toHexString(),
    sku: doc.sku,
    name: doc.name,
    description: doc.description,
    category: doc.category,
    unitOfMeasure: doc.unitOfMeasure,
    barcode: doc.barcode,
    unitCostCents: doc.unitCostCents,
    unitPriceCents: doc.unitPriceCents,
    reorderPoint: doc.reorderPoint,
    reorderQuantity: doc.reorderQuantity,
    status: doc.status,
    attributes: doc.attributes,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

export function toLocation(doc: LocationDoc): Location {
  return {
    id: doc._id.toHexString(),
    code: doc.code,
    name: doc.name,
    type: doc.type,
    parentId: doc.parentId ? doc.parentId.toHexString() : null,
    path: doc.path.map((id) => id.toHexString()),
    pathLabel: doc.pathLabel,
    isActive: doc.isActive,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

export function toMovement(doc: MovementDoc): Movement {
  return {
    id: doc._id.toHexString(),
    itemId: doc.itemId.toHexString(),
    itemSku: doc.itemSku,
    itemName: doc.itemName,
    locationId: doc.locationId.toHexString(),
    locationCode: doc.locationCode,
    quantity: doc.quantity,
    type: doc.type,
    reference: doc.reference,
    note: doc.note,
    groupId: doc.groupId ? doc.groupId.toHexString() : null,
    reversesId: doc.reversesId ? doc.reversesId.toHexString() : null,
    reason: doc.reason ?? null,
    occurredAt: doc.occurredAt.toISOString(),
    actorId: doc.actorId.toHexString(),
    actorName: doc.actorName,
    createdAt: doc.createdAt.toISOString(),
  };
}

export function toStockLevel(doc: StockLevelDoc): StockLevel {
  return {
    itemId: doc.itemId.toHexString(),
    locationId: doc.locationId.toHexString(),
    locationCode: doc.locationCode,
    onHand: doc.onHand,
    updatedAt: doc.updatedAt.toISOString(),
  };
}
