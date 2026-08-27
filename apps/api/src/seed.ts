/**
 * Loads the demo dataset into the local database so a fresh clone has something
 * to look at, plus an account to sign in with. Development only - it refuses to
 * touch a production database.
 *
 * The dataset itself lives in `services/demoDataset.ts`, which is also what the
 * onboarding endpoint writes when somebody presses "load the demo dataset" in
 * the app. One catalogue, two ways in.
 *
 * Run with: pnpm db:seed
 */
import { ObjectId } from 'mongodb';
import { env } from './env.js';
import {
  DEMO_STATE_ID,
  connect,
  demoState,
  disconnect,
  ensureIndexes,
  getDb,
  items,
  locations,
  movements,
  rebuildStockLevels,
  schemaVersion,
  supplierItems,
  suppliers,
  users,
} from './db.js';
import { hashPassword } from './lib/password.js';
import { runMigrations } from './migrations/index.js';
import { HISTORY_DAYS, buildDemoDataset } from './services/demoDataset.js';

const DEMO_EMAIL = 'demo@invintelx.org';
const DEMO_PASSWORD = 'invintelx-demo-password';

async function main(): Promise<void> {
  if (env.NODE_ENV === 'production') {
    console.error('Refusing to seed a production database.');
    process.exit(1);
  }

  await connect();
  // Same order as boot, so a seeded development database is at the version the
  // code expects rather than looking un-migrated to the next `pnpm dev`.
  await runMigrations();
  await ensureIndexes();

  console.log(`Seeding ${env.MONGODB_DB}...`);

  /*
   * Wipe first so the seed is repeatable rather than accumulating duplicates.
   *
   * Asked of the database rather than written out as a list of collections. A
   * list is a second place the set of collections is recorded, and it rots
   * silently: whoever adds the next collection has no reason to look here, and
   * the failure is a seeded database that is half old data - rows pointing at
   * ids that were just deleted and rewritten.
   *
   * The schema version is the exception. `runMigrations` above has just brought
   * it up to date, and emptying it would leave a freshly seeded database
   * looking un-migrated to the next boot.
   */
  const database = getDb();
  const keep = schemaVersion().collectionName;
  const present = await database.listCollections({}, { nameOnly: true }).toArray();
  await Promise.all(
    present
      .filter((collection) => collection.name !== keep)
      .map((collection) => database.collection(collection.name).deleteMany({})),
  );

  const now = new Date();
  const adminId = new ObjectId();
  await users().insertOne({
    _id: adminId,
    email: DEMO_EMAIL,
    name: 'Demo Admin',
    passwordHash: await hashPassword(DEMO_PASSWORD),
    role: 'admin',
    createdAt: now,
    updatedAt: now,
  });

  const dataset = buildDemoDataset({ now, actorId: adminId, actorName: 'Demo Admin' });

  await items().insertMany(dataset.items);
  await locations().insertMany(dataset.locations);
  await suppliers().insertMany(dataset.suppliers);
  await supplierItems().insertMany(dataset.supplierItems);
  await movements().insertMany(dataset.movements);

  // Derive on-hand from the ledger rather than writing it, which is the same
  // path production uses and proves the projection is reproducible.
  const rebuilt = await rebuildStockLevels();

  // The same marker the app writes, so a seeded database offers the same
  // one-press wipe as one that loaded the demo through the UI.
  await demoState().insertOne({ _id: DEMO_STATE_ID, loadedAt: now, loadedBy: 'Demo Admin' });

  console.log(`  ${dataset.items.length} items`);
  console.log(`  ${dataset.locations.length} locations`);
  console.log(
    `  ${dataset.suppliers.length} suppliers with ${dataset.supplierItems.length} supply lines`,
  );
  console.log(`  ${dataset.movements.length} movements over ${HISTORY_DAYS} days`);
  console.log(`  ${rebuilt.levels} stock levels projected from the ledger`);
  console.log(`  1 user: ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
  console.log('Done.');

  await disconnect();
}

main().catch((err: unknown) => {
  console.error('Seed failed', err);
  process.exit(1);
});
