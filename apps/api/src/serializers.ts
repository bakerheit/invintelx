import {
  outstandingQuantity,
  purchaseOrderTotalCents,
  type AuditEntry,
  type Item,
  type Location,
  type Movement,
  type PublicUser,
  type PurchaseOrder,
  type PurchaseOrderLine,
  type StockLevel,
  type Supplier,
  type SupplierItem,
} from '@invintelx/shared';
import type {
  AuditEntryDoc,
  ItemDoc,
  LocationDoc,
  MovementDoc,
  PurchaseOrderDoc,
  PurchaseOrderLineDoc,
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
    /*
     * `?? null` rather than a direct read: movements written before purchase
     * orders existed have no such field at all, and a missing field must read as
     * "not against an order" rather than fail the response schema. That is also
     * why this pair needed no migration.
     */
    purchaseOrderId: doc.purchaseOrderId ? doc.purchaseOrderId.toHexString() : null,
    purchaseOrderLineId: doc.purchaseOrderLineId ? doc.purchaseOrderLineId.toHexString() : null,
    reason: doc.reason ?? null,
    occurredAt: doc.occurredAt.toISOString(),
    actorId: doc.actorId.toHexString(),
    actorName: doc.actorName,
    createdAt: doc.createdAt.toISOString(),
  };
}

/**
 * Outstanding and the two totals are computed here rather than stored.
 *
 * They are functions of quantities that are already on the document, so storing
 * them would create a second place for the same fact to live and a second way
 * for it to be wrong — the same reason on-hand is projected from the ledger
 * rather than written alongside it.
 */
export function toPurchaseOrderLine(line: PurchaseOrderLineDoc): PurchaseOrderLine {
  return {
    id: line._id.toHexString(),
    itemId: line.itemId.toHexString(),
    itemSku: line.itemSku,
    itemName: line.itemName,
    quantityOrdered: line.quantityOrdered,
    quantityReceived: line.quantityReceived,
    quantityOutstanding: outstandingQuantity(line),
    unitCostCents: line.unitCostCents,
    lineTotalCents: line.quantityOrdered * line.unitCostCents,
  };
}

export function toPurchaseOrder(doc: PurchaseOrderDoc): PurchaseOrder {
  return {
    id: doc._id.toHexString(),
    number: doc.number,
    supplierId: doc.supplierId.toHexString(),
    supplierCode: doc.supplierCode,
    supplierName: doc.supplierName,
    status: doc.status,
    expectedDate: doc.expectedDate ? doc.expectedDate.toISOString() : null,
    reference: doc.reference,
    note: doc.note,
    lines: doc.lines.map(toPurchaseOrderLine),
    totalCents: purchaseOrderTotalCents(doc.lines),
    sentAt: doc.sentAt ? doc.sentAt.toISOString() : null,
    closedAt: doc.closedAt ? doc.closedAt.toISOString() : null,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

/**
 * The changes are copied rather than passed through: the stored array is the
 * record, and handing the same object to a response body is how a mapper
 * eventually becomes a place values get mutated on their way out.
 */
export function toAuditEntry(doc: AuditEntryDoc): AuditEntry {
  return {
    id: doc._id.toHexString(),
    actorId: doc.actorId.toHexString(),
    actorName: doc.actorName,
    action: doc.action,
    entityType: doc.entityType,
    entityId: doc.entityId.toHexString(),
    entityLabel: doc.entityLabel,
    changes: doc.changes.map((change) => ({ ...change })),
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
