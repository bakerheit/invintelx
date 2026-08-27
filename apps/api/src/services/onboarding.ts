/**
 * First run: what this instance has in it, and the demo dataset's lifecycle.
 *
 * A fresh instance has no items, no locations and no movements, so every screen
 * has nothing to draw. The web app asks this service what state the instance is
 * in so the empty screens can agree on one place to send a new user, rather than
 * each apologising on its own.
 */
import { ObjectId } from 'mongodb';
import type {
  DemoDataCounts,
  DemoDataState,
  DemoRemovalResult,
  OnboardingState,
} from '@invintelx/shared';
import {
  DEMO_STATE_ID,
  demoState,
  items,
  locations,
  movements,
  rebuildStockLevels,
  supplierItems,
  suppliers,
} from '../db.js';
import { buildDemoDataset } from './demoDataset.js';

/** How many demo documents are still in each collection. Counted, never remembered. */
export async function countDemoData(): Promise<DemoDataCounts> {
  const [itemCount, locationCount, supplierCount, supplyLineCount, movementCount] =
    await Promise.all([
      items().countDocuments({ isDemo: true }),
      locations().countDocuments({ isDemo: true }),
      suppliers().countDocuments({ isDemo: true }),
      supplierItems().countDocuments({ isDemo: true }),
      movements().countDocuments({ isDemo: true }),
    ]);

  return {
    items: itemCount,
    locations: locationCount,
    suppliers: supplierCount,
    supplierItems: supplyLineCount,
    movements: movementCount,
  };
}

export async function isDemoLoaded(): Promise<boolean> {
  return (await demoState().findOne({ _id: DEMO_STATE_ID })) !== null;
}

/** Null when the demo dataset is not loaded. */
export async function readDemoState(): Promise<DemoDataState | null> {
  const marker = await demoState().findOne({ _id: DEMO_STATE_ID });
  if (!marker) return null;

  return {
    ...(await countDemoData()),
    loadedAt: marker.loadedAt.toISOString(),
    loadedBy: marker.loadedBy,
  };
}

export async function readOnboardingState(canManageDemo: boolean): Promise<OnboardingState> {
  const [itemCount, locationCount, movementCount, demo, refusal] = await Promise.all([
    // Archived items included: an archived SKU is still something somebody put
    // here, and an instance holding one is not a fresh instance.
    items().countDocuments({}),
    locations().countDocuments({}),
    movements().countDocuments({}),
    readDemoState(),
    whyDemoCannotLoad(),
  ]);

  return {
    items: itemCount,
    locations: locationCount,
    movements: movementCount,
    empty: itemCount === 0 && locationCount === 0 && movementCount === 0,
    demo,
    // Asked of the same function the endpoint enforces, so the screen cannot
    // offer a button the server would refuse or hide one it would accept.
    canLoadDemo: refusal === null,
    canManageDemo,
  };
}

/**
 * Why a load was refused, or null if it may go ahead.
 *
 * Two separate refusals rather than one, because they mean different things to
 * whoever is reading: an instance that already has the demo needs no second
 * copy, and an instance that has real data must not have forty invented SKUs
 * mixed into it.
 */
export type DemoLoadRefusal = 'already_loaded' | 'instance_not_empty';

export async function whyDemoCannotLoad(): Promise<DemoLoadRefusal | null> {
  if (await isDemoLoaded()) return 'already_loaded';

  const [realItems, realLocations, realMovements] = await Promise.all([
    items().countDocuments({ isDemo: { $ne: true } }, { limit: 1 }),
    locations().countDocuments({ isDemo: { $ne: true } }, { limit: 1 }),
    movements().countDocuments({ isDemo: { $ne: true } }, { limit: 1 }),
  ]);
  if (realItems + realLocations + realMovements > 0) return 'instance_not_empty';

  return null;
}

/**
 * Insert the demo dataset and project stock from it.
 *
 * The caller is responsible for having checked `whyDemoCannotLoad` first — this
 * writes whatever it is asked to.
 */
export async function loadDemoData(actor: {
  id: ObjectId;
  name: string;
}): Promise<DemoDataCounts> {
  // There is no marker, or the caller would have been refused — but there can
  // still be demo rows, left by a load that died between its first insert and
  // the marker at the end. Clearing them is what makes pressing the button
  // again the way out of that, rather than a unique-index collision on the
  // first SKU it tries to re-insert.
  await clearDemoRows();

  const now = new Date();
  const dataset = buildDemoDataset({ now, actorId: actor.id, actorName: actor.name });

  await locations().insertMany(dataset.locations);
  await items().insertMany(dataset.items);
  await suppliers().insertMany(dataset.suppliers);
  await supplierItems().insertMany(dataset.supplierItems);
  await movements().insertMany(dataset.movements);

  // On-hand is derived from the ledger rather than written, which is the same
  // path a real receipt takes.
  await rebuildStockLevels();

  // Last, so a load that died half way through leaves no marker claiming a
  // complete dataset — and leaves `whyDemoCannotLoad` reporting the leftovers
  // as an instance that is not empty rather than as a demo that can be wiped.
  await demoState().insertOne({
    _id: DEMO_STATE_ID,
    loadedAt: now,
    loadedBy: actor.name,
  });

  return countDemoData();
}

/**
 * Delete every demo row, and nothing else. Leaves the marker and the stock
 * projection alone — `removeDemoData` is the operation with a meaning, this is
 * the half of it that both callers share.
 *
 * Movements are removed by item as well as by flag: somebody who has been
 * looking around has probably issued a few units of a demo SKU, and those rows
 * are not marked demo. Leaving them would leave a ledger referencing items that
 * no longer exist — so anything that moved a demo item goes with it. The same
 * reasoning covers supply lines pointing at demo items.
 *
 * Locations and suppliers run the other way. A new instance has none of its own,
 * so the only warehouse anybody can receive their first real SKU into is a demo
 * one, and the only supplier they can price it from is a demo one. Deleting
 * those would honour the flag and break the promise the confirm dialog makes:
 * their item would survive with its stock sitting at a location that no longer
 * exists. So a demo location or supplier that surviving data still points at is
 * kept and stops being demo — the user has adopted it, and it is theirs now.
 *
 * These deletes go straight at the collections rather than through the audit
 * helpers, and that is a decision rather than an oversight. The audit log is a
 * record of what people did to their data; the demo dataset is not their data,
 * and writing forty deletions into the log would bury a real edit on a brand new
 * instance under rows about SKUs that never existed. What it does leave behind is
 * an entry for any demo row a user edited by hand before wiping — that row
 * outlives its subject, which is what the log is for and is why nothing here
 * deletes from it. Recorded on INVX-65 rather than decided quietly.
 */
async function clearDemoRows(): Promise<DemoRemovalResult> {
  const demoItemIds = (
    await items().find({ isDemo: true }, { projection: { _id: 1 } }).toArray()
  ).map((doc) => doc._id);

  const removedMovements = await movements().deleteMany({
    $or: [{ isDemo: true }, { itemId: { $in: demoItemIds } }],
  });
  const removedSupplyLines = await supplierItems().deleteMany({
    $or: [{ isDemo: true }, { itemId: { $in: demoItemIds } }],
  });
  const removedItems = await items().deleteMany({ isDemo: true });

  /*
   * Asked after the deletes above, so what is left in these two collections is
   * exactly the data that is going to survive this call. Anything it references
   * is load-bearing by definition; a demo flag on the other end of that
   * reference is out of date rather than an instruction.
   */
  const [stillUsedLocations, stillUsedSuppliers] = await Promise.all([
    movements().distinct('locationId', {}),
    supplierItems().distinct('supplierId', {}),
  ]);

  // Unset before the delete, so the retained rows no longer match it.
  const [retainedLocations, retainedSuppliers] = await Promise.all([
    locations().updateMany(
      { isDemo: true, _id: { $in: stillUsedLocations } },
      { $unset: { isDemo: '' } },
    ),
    suppliers().updateMany(
      { isDemo: true, _id: { $in: stillUsedSuppliers } },
      { $unset: { isDemo: '' } },
    ),
  ]);

  const removedSuppliers = await suppliers().deleteMany({ isDemo: true });
  const removedLocations = await locations().deleteMany({ isDemo: true });

  return {
    items: removedItems.deletedCount,
    locations: removedLocations.deletedCount,
    suppliers: removedSuppliers.deletedCount,
    supplierItems: removedSupplyLines.deletedCount,
    movements: removedMovements.deletedCount,
    retainedLocations: retainedLocations.modifiedCount,
    retainedSuppliers: retainedSuppliers.modifiedCount,
  };
}

/** Take the demo back out: its rows, its stock, and the record that it was here. */
export async function removeDemoData(): Promise<DemoRemovalResult> {
  const removed = await clearDemoRows();

  // The projection is downstream of the ledger, so rebuilding it is what makes
  // the deleted rows stop counting as stock on hand.
  await rebuildStockLevels();
  await demoState().deleteMany({});

  return removed;
}
