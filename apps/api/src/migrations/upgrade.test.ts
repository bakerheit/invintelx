import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { BSON } from 'mongodb';
import type * as DbModule from '../db.js';
import type * as ListModule from './list.js';
import type * as RunnerModule from './runner.js';

/**
 * The upgrade path, exercised across a version boundary rather than described.
 *
 * Every file in `fixtures/` is a small database in the shape a released version
 * left behind, frozen when that version was tagged. This restores each of them
 * and runs what boot runs — `runMigrations()` then `ensureIndexes()` — which is
 * the whole of what an upgrade does to a self-hoster's data. Then it asks the
 * only questions that matter afterwards:
 *
 *  - is everything that was there still there,
 *  - does the on-hand projection still reconcile against the ledger,
 *  - and did the database land on the version this build expects.
 *
 * The reconcile check is the one worth being careful about. `rebuildStockLevels`
 * would make the numbers agree whatever state they were in, so this compares
 * without rebuilding: it is evidence that the migrations left the projection
 * consistent with the ledger, not that a repair could be made to.
 *
 * Each fixture goes to the current build in **one hop**, never through the
 * versions in between. That is deliberate — it is what backs the claim in
 * `docs/upgrading.md` that releases may be skipped. A test that walked every
 * intermediate version would prove a policy nobody is offering.
 */

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/', import.meta.url));
const CHANGELOG = fileURLToPath(new URL('../../../../CHANGELOG.md', import.meta.url));

type Doc = Record<string, unknown>;

interface Fixture {
  file: string;
  release: string;
  /** What that release's `schemaVersion` document records. */
  schemaVersion: number;
  /** Kept unparsed so every test gets its own documents to hand to the driver. */
  raw: string;
}

function parseExtendedJson(text: string): unknown {
  // Relaxed, so `$date` is a Date and a JSON number stays a number. Canonical
  // would hand back Int32 and Double wrappers, which no fixture needs and every
  // assertion would then have to know about.
  return BSON.EJSON.parse(text) as unknown;
}

/** Semver order. Fixtures exist for real releases, so a suffix is a mistake, not a case. */
function compareVersions(a: string, b: string): number {
  const parts = (version: string): number[] =>
    version.split('-')[0]?.split('.').map(Number) ?? [];
  const left = parts(a);
  const right = parts(b);
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function loadFixtures(): Fixture[] {
  const files = readdirSync(FIXTURE_DIR).filter((name) => name.endsWith('.json'));
  const fixtures = files.map((file) => {
    const raw = readFileSync(join(FIXTURE_DIR, file), 'utf8');
    const parsed = parseExtendedJson(raw) as { release?: unknown; schemaVersion?: unknown };
    if (typeof parsed.release !== 'string' || typeof parsed.schemaVersion !== 'number') {
      throw new Error(`fixtures/${file} needs a "release" string and a "schemaVersion" number.`);
    }
    return { file, release: parsed.release, schemaVersion: parsed.schemaVersion, raw };
  });
  return fixtures.sort((a, b) => compareVersions(a.release, b.release));
}

function collectionsOf(fixture: Fixture): Record<string, Doc[]> {
  const parsed = parseExtendedJson(fixture.raw) as { collections?: Record<string, Doc[]> };
  return parsed.collections ?? {};
}

function movementsOf(fixture: Fixture): Doc[] {
  return collectionsOf(fixture).movements ?? [];
}

/** Every version the changelog says has actually been released. */
function releasedVersions(): string[] {
  const changelog = readFileSync(CHANGELOG, 'utf8');
  const headings = changelog.matchAll(/^## \[(\d+\.\d+\.\d+[^\]]*)\] - \d{4}-\d{2}-\d{2}/gm);
  return [...headings].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
}

const FIXTURES = loadFixtures();
const OLDEST = FIXTURES[0];

/**
 * A database as it stood before this build got hold of it.
 *
 * The fixtures give one each. The extra case is the database nobody wrote a
 * fixture for because it predates the mechanism: the same shape with no
 * `schemaVersion` document at all, which is what every instance running today
 * is, including invintelx.org.
 */
interface StartingPoint {
  label: string;
  fixture: Fixture;
  /** False for the pre-migration case: restore the data, record nothing about it. */
  recordSchemaVersion: boolean;
  expectedVersionBefore: number;
}

const STARTING_POINTS: StartingPoint[] = [
  ...FIXTURES.map((fixture) => ({
    label: `release ${fixture.release}`,
    fixture,
    recordSchemaVersion: true,
    expectedVersionBefore: fixture.schemaVersion,
  })),
  ...(OLDEST === undefined
    ? []
    : [
        {
          label: `a database from before migrations existed (${OLDEST.release} shape)`,
          fixture: OLDEST,
          recordSchemaVersion: false,
          expectedVersionBefore: 0,
        },
      ]),
];

let replSet: MongoMemoryReplSet;
let db: typeof DbModule;
let runner: typeof RunnerModule;
let list: typeof ListModule;

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });

  process.env.NODE_ENV = 'test';
  process.env.MONGODB_URI = replSet.getUri();
  process.env.MONGODB_DB = 'invintelx_upgrade_test';
  process.env.SESSION_SECRET = 'test-secret-that-is-definitely-long-enough';

  db = await import('../db.js');
  await db.connect();
  runner = await import('./runner.js');
  list = await import('./list.js');
}, 120_000);

afterAll(async () => {
  await db?.disconnect();
  await replSet?.stop();
});

/**
 * Put the database into the shape the old release left it in.
 *
 * Collections are dropped rather than emptied, so their indexes go with them and
 * the `ensureIndexes()` in `upgrade()` below has to create every one of them
 * against the restored data. An old dataset that a new unique index cannot
 * accept is an upgrade failure, and this is where it would show up.
 */
async function restore(point: StartingPoint): Promise<void> {
  const database = db.getDb();
  for (const existing of await database.listCollections({}, { nameOnly: true }).toArray()) {
    await database.dropCollection(existing.name);
  }

  for (const [name, docs] of Object.entries(collectionsOf(point.fixture))) {
    if (name === 'schemaVersion' && !point.recordSchemaVersion) continue;
    if (docs.length === 0) continue;
    await database.collection(name).insertMany(docs);
  }
}

/** What `index.ts` does to a database before it will serve a request. */
async function upgrade(): Promise<RunnerModule.MigrationRunResult> {
  const result = await runner.runMigrations({ log: () => {} });
  await db.ensureIndexes();
  return result;
}

/** Everything the upgrade was not allowed to lose, in a form two runs can be compared by. */
async function snapshot(): Promise<Record<string, Doc[]>> {
  const database = db.getDb();
  const names = (await database.listCollections({}, { nameOnly: true }).toArray())
    .map((collection) => collection.name)
    // Excluded on purpose: the version document is the one thing an upgrade is
    // supposed to change.
    .filter((name) => name !== 'schemaVersion')
    .sort();

  const out: Record<string, Doc[]> = {};
  for (const name of names) {
    out[name] = (await database.collection(name).find({}).sort({ _id: 1 }).toArray()) as Doc[];
  }
  return out;
}

async function idsIn(collection: string): Promise<Set<string>> {
  const docs = await db
    .getDb()
    .collection(collection)
    .find({}, { projection: { _id: 1 } })
    .toArray();
  return new Set(docs.map((doc) => String(doc._id)));
}

describe.each(STARTING_POINTS)('upgrading $label to this build', (point) => {
  let versionBeforeUpgrade: number;
  let reconciledBeforeUpgrade: DbModule.StockLevelVerification;
  let result: RunnerModule.MigrationRunResult;

  beforeAll(async () => {
    await restore(point);
    versionBeforeUpgrade = (await runner.readSchemaState()).version;
    reconciledBeforeUpgrade = await db.verifyStockLevels();
    result = await upgrade();
  }, 60_000);

  it('was at the version that release recorded', () => {
    expect(versionBeforeUpgrade).toBe(point.expectedVersionBefore);
  });

  it('came from a snapshot whose on-hand figures already agreed with its ledger', () => {
    // A fixture that was inconsistent to begin with would make the reconcile
    // assertion below a statement about the fixture rather than the migrations.
    expect(reconciledBeforeUpgrade.discrepancies).toEqual([]);
  });

  it('lands on the schema version this build ships, in one hop', async () => {
    expect(result.versionBefore).toBe(point.expectedVersionBefore);
    expect(result.versionAfter).toBe(list.LATEST_SCHEMA_VERSION);

    const state = await runner.readSchemaState();
    expect(state.applied.map((entry) => entry.name)).toEqual(list.MIGRATIONS.map((m) => m.name));
    // Recorded once each, however many were outstanding when we started.
    expect(new Set(state.applied.map((entry) => entry.version)).size).toBe(state.applied.length);
  });

  it('loses no document from any collection', async () => {
    const missing: string[] = [];
    for (const [name, docs] of Object.entries(collectionsOf(point.fixture))) {
      if (name === 'schemaVersion') continue;
      const surviving = await idsIn(name);
      for (const doc of docs) {
        if (!surviving.has(String(doc._id))) missing.push(`${name}/${String(doc._id)}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('leaves every movement it inherited untouched, unless a migration declared a rewrite', async () => {
    const rewrote = result.ran.some(
      (name) => list.MIGRATIONS.find((m) => m.name === name)?.ledger === 'rewrite',
    );

    const after = (await db.getDb().collection('movements').find({}).toArray()) as Doc[];
    const byId = new Map(after.map((doc): [string, Doc] => [String(doc._id), doc]));

    if (rewrote) {
      // A declared rewrite is the one case where inherited rows may legitimately
      // change. That they still exist is `loses no document` above.
      expect(movementsOf(point.fixture).every((doc) => byId.has(String(doc._id)))).toBe(true);
      return;
    }

    for (const doc of movementsOf(point.fixture)) {
      expect(byId.get(String(doc._id))).toEqual(doc);
    }
  });

  it('leaves the on-hand projection reconciling against the ledger', async () => {
    const verification = await db.verifyStockLevels();

    expect(verification.discrepancies).toEqual([]);
    expect(verification.storedLevels).toBe(verification.expectedLevels);
    expect(verification.movements).toBe(movementsOf(point.fixture).length);
  });

  it('changes nothing at all when the same build boots again', async () => {
    const before = await snapshot();

    const again = await upgrade();

    expect(again.ran).toEqual([]);
    expect(again.versionAfter).toBe(list.LATEST_SCHEMA_VERSION);
    expect(await snapshot()).toEqual(before);
  });
});

describe('the reconcile assertion itself', () => {
  it('fails when the projection and the ledger disagree', async () => {
    // Without this, every "reconciles against the ledger" above could be passing
    // because nothing is really being compared. Break one figure on purpose.
    const point = STARTING_POINTS[0];
    expect(point).toBeDefined();
    if (point === undefined) return;

    await restore(point);
    await upgrade();
    expect((await db.verifyStockLevels()).discrepancies).toEqual([]);

    await db.stockLevels().updateOne({}, { $inc: { onHand: 1 } });

    const verification = await db.verifyStockLevels();
    expect(verification.discrepancies).toHaveLength(1);
    const [discrepancy] = verification.discrepancies;
    expect(discrepancy?.stored).not.toBe(discrepancy?.ledger);
  });
});

describe('fixture coverage', () => {
  it('has a fixture for every version the changelog says was released', () => {
    const covered = new Set(FIXTURES.map((fixture) => fixture.release));
    const uncovered = releasedVersions().filter((version) => !covered.has(version));

    // Cutting a release adds its fixture in the same pull request that closes
    // the changelog section, so this is what makes "an upgrade from any
    // supported release is exercised" true rather than aspirational. See
    // apps/api/src/migrations/fixtures/README.md.
    expect(uncovered).toEqual([]);
  });

  it('names each fixture after the release it records', () => {
    const mismatched = FIXTURES.filter((fixture) => fixture.file !== `v${fixture.release}.json`);
    expect(mismatched.map((fixture) => fixture.file)).toEqual([]);
  });

  it('has no fixture claiming a schema version this build has never heard of', () => {
    const ahead = FIXTURES.filter(
      (fixture) => fixture.schemaVersion > list.LATEST_SCHEMA_VERSION,
    ).map((fixture) => `${fixture.release} records schema version ${fixture.schemaVersion}`);

    // A fixture ahead of the code is either a migration that was deleted or a
    // fixture written from a version that never shipped.
    expect(ahead).toEqual([]);
  });
});
