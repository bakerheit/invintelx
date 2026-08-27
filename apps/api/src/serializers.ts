import {
  lineVariance,
  summariseCountSheet,
  type CountSheet,
  type CountSheetDetail,
  type CountSheetLine,
  type Item,
  type Location,
  type Movement,
  type PublicUser,
  type StockLevel,
  type Supplier,
  type SupplierItem,
} from '@invintelx/shared';
import type {
  CountSheetDoc,
  CountSheetLineDoc,
  ItemDoc,
  LocationDoc,
  MovementDoc,
  StockLevelDoc,
  SupplierDoc,
  SupplierItemDoc,
  UserDoc,
} from './db.js';

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

export function toSupplier(doc: SupplierDoc): Supplier {
  return {
    id: doc._id.toHexString(),
    code: doc.code,
    name: doc.name,
    status: doc.status,
    contact: {
      name: doc.contact.name,
      email: doc.contact.email,
      phone: doc.contact.phone,
      website: doc.contact.website,
      address: doc.contact.address,
    },
    paymentTerms: doc.paymentTerms,
    currency: doc.currency,
    promisedLeadTimeDays: doc.promisedLeadTimeDays,
    notes: doc.notes,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

/**
 * The item is passed in rather than looked up here, so that listing a hundred
 * lines is one query for the items and not a hundred.
 */
export function toSupplierItem(doc: SupplierItemDoc, item: ItemDoc | null): SupplierItem {
  return {
    id: doc._id.toHexString(),
    supplierId: doc.supplierId.toHexString(),
    itemId: doc.itemId.toHexString(),
    supplierSku: doc.supplierSku,
    priceBreaks: doc.priceBreaks.map((brk) => ({ ...brk })),
    item: item ? toItem(item) : null,
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

export function toCountSheetLine(doc: CountSheetLineDoc): CountSheetLine {
  return {
    id: doc._id.toHexString(),
    itemId: doc.itemId.toHexString(),
    itemSku: doc.itemSku,
    itemName: doc.itemName,
    expectedQuantity: doc.expectedQuantity,
    countedQuantity: doc.countedQuantity,
    // Sent rather than left to the client to work out, so the number on the
    // screen and the number the adjustment was written from are the same one.
    variance: lineVariance(doc),
    countedAt: doc.countedAt ? doc.countedAt.toISOString() : null,
    countedByName: doc.countedByName,
    postedMovementId: doc.postedMovementId ? doc.postedMovementId.toHexString() : null,
    postedQuantity: doc.postedQuantity,
  };
}

/** The sheet without its lines: what a list of sheets needs and no more. */
export function toCountSheet(doc: CountSheetDoc): CountSheet {
  return {
    id: doc._id.toHexString(),
    reference: doc.reference,
    locationId: doc.locationId.toHexString(),
    locationCode: doc.locationCode,
    locationPathLabel: doc.locationPathLabel,
    scope: doc.scope,
    status: doc.status,
    note: doc.note,
    summary: summariseCountSheet(doc.lines),
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
    createdByName: doc.createdByName,
    postedAt: doc.postedAt ? doc.postedAt.toISOString() : null,
    postedByName: doc.postedByName,
    cancelledAt: doc.cancelledAt ? doc.cancelledAt.toISOString() : null,
  };
}

export function toCountSheetDetail(doc: CountSheetDoc): CountSheetDetail {
  return { ...toCountSheet(doc), lines: doc.lines.map(toCountSheetLine) };
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
