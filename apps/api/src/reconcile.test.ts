import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { ObjectId } from 'mongodb';
import type * as DbModule from './db.js';
import { advice, countKinds, formatVerification, isClean } from './lib/reconcileReport.js';
import type { StockLevelVerification } from './db.js';

/**
 * The check that ends a restore, tested against a real mongod for the same
 * reason the ledger suite is: what is being proved is a property of an
 * aggregation over stored documents, and a fake would agree with the assertions
 * whether or not the aggregation is right.
 *
 * These write `movements` and `stockLevels` directly rather than going through
 * the API, because the interesting cases are the ones the API cannot produce —
 * a projection that disagrees with the ledger is exactly what a torn dump leaves
 * behind, and no sequence of valid requests creates one.
 */
let replSet: MongoMemoryReplSet;
let db: typeof DbModule;

const ITEM_A = new ObjectId();
const ITEM_B = new ObjectId();
const BIN_1 = new ObjectId();
const BIN_2 = new ObjectId();

/** Only the fields the projection is derived from; the rest never enters the sum. */
async function movement(
  itemId: ObjectId,
  locationId: ObjectId,
  locationCode: string,
  quantity: number,
): Promise<void> {
  await db
    .getDb()
    .collection('movements')
    .insertOne({ _id: new ObjectId(), itemId, locationId, locationCode, quantity });
}

async function level(
  itemId: ObjectId,
  locationId: ObjectId,
  locationCode: string,
  onHand: number,
): Promise<void> {
  await db.stockLevels().insertOne({
    _id: new ObjectId(),
    itemId,
    locationId,
    locationCode,
    onHand,
    updatedAt: new Date(),
  });
}

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });

  process.env.NODE_ENV = 'test';
  process.env.MONGODB_URI = replSet.getUri();
  process.env.MONGODB_DB = 'invintelx_reconcile_test';
  process.env.SESSION_SECRET = 'test-secret-that-is-definitely-long-enough';

  db = await import('./db.js');
  await db.connect();
}, 120_000);

afterAll(async () => {
  await db?.disconnect();
  await replSet?.stop();
});

beforeEach(async () => {
  await db.getDb().collection('movements').deleteMany({});
  await db.stockLevels().deleteMany({});
});

describe('verifying the projection against the ledger', () => {
  it('an empty database agrees with itself', async () => {
    const result = await db.verifyStockLevels();

    expect(result).toEqual({
      movements: 0,
      expectedLevels: 0,
      storedLevels: 0,
      discrepancies: [],
    });
  });

  it('reports nothing when every figure re-derives to what is stored', async () => {
    await movement(ITEM_A, BIN_1, 'A-01', 50);
    await movement(ITEM_A, BIN_1, 'A-01', -20);
    await movement(ITEM_B, BIN_2, 'A-02', 7);
    await level(ITEM_A, BIN_1, 'A-01', 30);
    await level(ITEM_B, BIN_2, 'A-02', 7);

    const result = await db.verifyStockLevels();

    expect(result.movements).toBe(3);
    expect(result.expectedLevels).toBe(2);
    expect(result.storedLevels).toBe(2);
    expect(result.discrepancies).toEqual([]);
  });

  it('names a figure that disagrees, with both numbers', async () => {
    await movement(ITEM_A, BIN_1, 'A-01', 40);
    await level(ITEM_A, BIN_1, 'A-01', 55);

    const { discrepancies } = await db.verifyStockLevels();

    expect(discrepancies).toHaveLength(1);
    expect(discrepancies[0]).toMatchObject({ locationCode: 'A-01', stored: 55, ledger: 40 });
  });

  /* The half of a torn dump where the movement was read and the level was not. */
  it('reports a pair the ledger has movements for and the projection has no row for', async () => {
    await movement(ITEM_A, BIN_1, 'A-01', 40);

    const { discrepancies, expectedLevels, storedLevels } = await db.verifyStockLevels();

    expect(expectedLevels).toBe(1);
    expect(storedLevels).toBe(0);
    expect(discrepancies).toHaveLength(1);
    expect(discrepancies[0]).toMatchObject({ locationCode: 'A-01', stored: null, ledger: 40 });
  });

  /* And the other half: a level whose movements never made it into the dump. */
  it('reports a projection row the ledger knows nothing about', async () => {
    await level(ITEM_A, BIN_1, 'A-01', 12);

    const { discrepancies } = await db.verifyStockLevels();

    expect(discrepancies).toHaveLength(1);
    expect(discrepancies[0]).toMatchObject({ locationCode: 'A-01', stored: 12, ledger: null });
  });

  /*
   * A pair whose movements cancel out still has a row, because the ledger
   * implies one. Treating "sums to zero" as "no row" would make the check
   * disagree with the rebuild, which writes that row.
   */
  it('expects a zero row for a pair whose movements net to nothing', async () => {
    await movement(ITEM_A, BIN_1, 'A-01', 5);
    await movement(ITEM_A, BIN_1, 'A-01', -5);
    await level(ITEM_A, BIN_1, 'A-01', 0);

    expect((await db.verifyStockLevels()).discrepancies).toEqual([]);
  });

  it('writes nothing, so the disagreement is still there afterwards', async () => {
    await movement(ITEM_A, BIN_1, 'A-01', 40);
    await level(ITEM_A, BIN_1, 'A-01', 55);

    await db.verifyStockLevels();

    const stored = await db.stockLevels().findOne({ itemId: ITEM_A });
    expect(stored?.onHand).toBe(55);
    expect((await db.verifyStockLevels()).discrepancies).toHaveLength(1);
  });

  it('lists disagreements in location order, so two runs read the same', async () => {
    await movement(ITEM_A, BIN_1, 'C-03', 1);
    await movement(ITEM_A, BIN_2, 'A-01', 1);
    await movement(ITEM_B, BIN_2, 'B-02', 1);

    const { discrepancies } = await db.verifyStockLevels();

    expect(discrepancies.map((d) => d.locationCode)).toEqual(['A-01', 'B-02', 'C-03']);
  });

  it('a rebuild is what makes the check pass, and the check proves it', async () => {
    await movement(ITEM_A, BIN_1, 'A-01', 40);
    await movement(ITEM_B, BIN_2, 'A-02', 7);
    await level(ITEM_A, BIN_1, 'A-01', 999_999);

    expect((await db.verifyStockLevels()).discrepancies).toHaveLength(2);

    await db.rebuildStockLevels();

    expect((await db.verifyStockLevels()).discrepancies).toEqual([]);
  });
});

describe('what the report says', () => {
  const clean: StockLevelVerification = {
    movements: 12,
    expectedLevels: 2,
    storedLevels: 2,
    discrepancies: [],
  };

  const dirty: StockLevelVerification = {
    movements: 12,
    expectedLevels: 3,
    storedLevels: 3,
    discrepancies: [
      { itemId: ITEM_A, locationId: BIN_1, locationCode: 'A-01', stored: 55, ledger: 40 },
      { itemId: ITEM_A, locationId: BIN_2, locationCode: 'A-02', stored: null, ledger: 20 },
      { itemId: ITEM_B, locationId: BIN_2, locationCode: 'B-03', stored: 5, ledger: null },
    ],
  };

  it('says so plainly when there is nothing wrong', () => {
    expect(isClean(clean)).toBe(true);
    expect(formatVerification(clean)[0]).toBe('The projection matches the ledger.');
  });

  it('counts the three shapes a disagreement comes in separately', () => {
    expect(countKinds(dirty.discrepancies)).toEqual({
      wrong: 1,
      missing: 1,
      unknownToLedger: 1,
    });
  });

  it('prints every disagreement with both numbers and the item it is about', () => {
    const report = formatVerification(dirty).join('\n');

    expect(report).toContain('does NOT match');
    expect(report).toContain('1 wrong, 1 missing from the projection, 1 not in the ledger');
    expect(report).toContain(ITEM_A.toHexString());
    expect(report).toContain(ITEM_B.toHexString());
    for (const code of ['A-01', 'A-02', 'B-03']) expect(report).toContain(code);
    // An absent side is named rather than shown as a zero, which would read as
    // a real on-hand figure of nothing.
    expect(report).toContain('(none)');
  });

  it('caps the list rather than dumping a whole broken projection', () => {
    const many: StockLevelVerification = {
      movements: 500,
      expectedLevels: 50,
      storedLevels: 50,
      discrepancies: Array.from({ length: 50 }, (_, i) => ({
        itemId: ITEM_A,
        locationId: BIN_1,
        locationCode: `A-${String(i).padStart(3, '0')}`,
        stored: i,
        ledger: i + 1,
      })),
    };

    const report = formatVerification(many).join('\n');

    expect(report).toContain('50 disagreements');
    expect(report).toContain('... and 30 more');
    expect(report).toContain('A-019');
    expect(report).not.toContain('A-020');
  });

  it('tells a clean read-only run that it wrote nothing and what that does not prove', () => {
    const said = advice(clean, false).join('\n');

    expect(said).toContain('Nothing was written');
    expect(said).toContain('does not prove the snapshot is up to date');
  });

  it('points a dirty read-only run at the dump, not at the rebuild first', () => {
    const said = advice(dirty, false).join('\n');

    expect(said).toContain('torn');
    expect(said).toContain('docs/backup-and-restore.md');
    expect(said).toContain('destroys the evidence');
  });

  it('treats a disagreement that survived a rebuild as a different problem', () => {
    const said = advice(dirty, true).join('\n');

    expect(said).toContain('survived a rebuild');
    expect(said).not.toContain('torn');
  });
});
