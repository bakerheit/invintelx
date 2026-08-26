import { ObjectId, type AnyBulkWriteOperation } from 'mongodb';
import type { ExistingItem, ItemImportPlan, ItemImportResult } from '@invintelx/shared';
import { getClient, items, type ItemDoc } from '../db.js';

/**
 * The database half of a CSV import. All the deciding happens in
 * `planItemImport` in the shared package, which is pure and therefore the same
 * code the preview ran; this file only reads what exists and writes what the
 * plan says.
 */

/** How many rows one file may carry. */
export const MAX_IMPORT_ROWS = 20_000;

/**
 * The items the file mentions, keyed by SKU.
 *
 * Archived items are included. Leaving them out would make a re-import of a
 * previously exported file create a second item with the same SKU, which the
 * unique index would then refuse — an import that fails on data it exported
 * itself is exactly the thing that makes people stop trusting the feature.
 */
export async function loadExistingBySku(skus: string[]): Promise<Map<string, ExistingItem>> {
  const found = new Map<string, ExistingItem>();
  if (skus.length === 0) return found;

  const docs = await items()
    .find({ sku: { $in: skus } })
    .toArray();

  for (const doc of docs) {
    found.set(doc.sku, {
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
    });
  }

  return found;
}

/**
 * Write the plan.
 *
 * In one transaction, because a bulk import is a single thing a person decided
 * to do: half a price list is worse than none, and "which of my four thousand
 * rows landed?" is not a question anyone should have to answer from the audit
 * log. A row the plan marked unchanged is not written at all, so re-importing
 * an unmodified export leaves every `updatedAt` alone.
 */
export async function applyItemImport(plan: ItemImportPlan): Promise<ItemImportResult> {
  const now = new Date();
  const operations: AnyBulkWriteOperation<ItemDoc>[] = [];
  let created = 0;
  let updated = 0;
  let unchanged = 0;

  for (const row of plan.rows) {
    if (row.action === 'unchanged') unchanged += 1;
    if (!row.write) continue;

    if (row.write.kind === 'create') {
      operations.push({
        insertOne: {
          document: { _id: new ObjectId(), ...row.write.values, createdAt: now, updatedAt: now },
        },
      });
      created += 1;
    } else {
      operations.push({
        updateOne: {
          filter: { sku: row.write.sku },
          update: { $set: { ...row.write.changes, updatedAt: now } },
        },
      });
      updated += 1;
    }
  }

  if (operations.length > 0) {
    const session = getClient().startSession();
    try {
      await session.withTransaction(async () => {
        // Ordered: a duplicate SKU racing in from another request should stop
        // the import rather than let the rest of the file through around it.
        await items().bulkWrite(operations, { session, ordered: true });
      });
    } finally {
      await session.endSession();
    }
  }

  return { created, updated, unchanged };
}
