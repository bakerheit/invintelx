import type { Item, PublicUser } from '@invintelx/shared';
import type { ItemDoc, UserDoc } from './db.js';

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
