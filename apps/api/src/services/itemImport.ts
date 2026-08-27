import { ObjectId, type AnyBulkWriteOperation } from 'mongodb';
import type { ExistingItem, ItemImportPlan, ItemImportResult } from '@invintelx/shared';
import { getClient, items, type ItemDoc } from '../db.js';
import {
  diffAuditDocuments,
  recordAuditEvents,
  type Actor,
  type AuditEventInput,
} from './audit.js';

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
 *
 * The audit entries ride in the same transaction. An import is the fastest way
 * in this product to change four thousand costs at once, so it is the write
 * that most needs a record — and one entry per row, rather than one for the
 * file, is what makes "when did this SKU's cost change" answerable on the item
 * itself rather than only in a list of uploads.
 */
export async function applyItemImport(
  plan: ItemImportPlan,
  actor: Actor,
): Promise<ItemImportResult> {
  const now = new Date();
  const operations: AnyBulkWriteOperation<ItemDoc>[] = [];
  const createdDocs: ItemDoc[] = [];
  const updatedSkus: string[] = [];
  const changesBySku = new Map<string, Partial<ItemDoc>>();
  let created = 0;
  let updated = 0;
  let unchanged = 0;

  for (const row of plan.rows) {
    if (row.action === 'unchanged') unchanged += 1;
    if (!row.write) continue;

    if (row.write.kind === 'create') {
      const document: ItemDoc = {
        _id: new ObjectId(),
        ...row.write.values,
        createdAt: now,
        updatedAt: now,
      };
      operations.push({ insertOne: { document } });
      createdDocs.push(document);
      created += 1;
    } else {
      operations.push({
        updateOne: {
          filter: { sku: row.write.sku },
          update: { $set: { ...row.write.changes, updatedAt: now } },
        },
      });
      updatedSkus.push(row.write.sku);
      changesBySku.set(row.write.sku, row.write.changes as Partial<ItemDoc>);
      updated += 1;
    }
  }

  if (operations.length > 0) {
    const session = getClient().startSession();
    try {
      await session.withTransaction(async () => {
        /*
         * Read the rows about to be overwritten before overwriting them, inside
         * the transaction. The plan's view of "what exists" was taken before
         * the preview was even shown; what the entry has to say is what this
         * write actually replaced.
         */
        const before =
          updatedSkus.length === 0
            ? []
            : await items()
                .find({ sku: { $in: updatedSkus } }, { session })
                .toArray();

        // Ordered: a duplicate SKU racing in from another request should stop
        // the import rather than let the rest of the file through around it.
        await items().bulkWrite(operations, { session, ordered: true });

        const entries: AuditEventInput[] = createdDocs.map((doc) => ({
          actor,
          action: 'import' as const,
          entityType: 'item' as const,
          entityId: doc._id,
          entityLabel: doc.sku,
          changes: diffAuditDocuments({}, doc),
        }));

        for (const doc of before) {
          const changes = changesBySku.get(doc.sku);
          if (!changes) continue;
          entries.push({
            actor,
            action: 'import',
            entityType: 'item',
            entityId: doc._id,
            entityLabel: doc.sku,
            // Diffed against the row as it will be, not against the plan's
            // intent, so a field the file mentions but does not move records
            // nothing.
            changes: diffAuditDocuments(doc, { ...doc, ...changes }),
          });
        }

        await recordAuditEvents(entries, session);
      });
    } finally {
      await session.endSession();
    }
  }

  return { created, updated, unchanged };
}
