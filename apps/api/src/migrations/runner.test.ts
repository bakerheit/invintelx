import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { ObjectId } from 'mongodb';
import type * as DbModule from '../db.js';
import type * as RunnerModule from './runner.js';
import type * as ListModule from './list.js';
import type { Migration } from './types.js';

/**
 * These run against a real mongod because everything worth proving here is a
 * property of the database rather than of this process: that two boots racing
 * each other run each migration once, that a lock left by a killed process is
 * eventually taken over, and that a version older code cannot understand stops
 * the boot. A mock would agree with any of those, including when they are false.
 */
let replSet: MongoMemoryReplSet;
let db: typeof DbModule;
let runner: typeof RunnerModule;
let list: typeof ListModule;

/** Records the order migrations actually ran in, across a single call. */
let executed: string[];
let logged: string[];

const log = (message: string): void => {
  logged.push(message);
};

/**
 * A migration that records the fact it ran, so the assertions can be about
 * order and count rather than about side effects invented for the purpose.
 */
function migration(version: number, over: Partial<Migration> = {}): Migration {
  const name = over.name ?? `m${version}`;
  const body = over.up;
  const built: Migration = {
    version,
    name,
    up: async (ctx) => {
      executed.push(name);
      await body?.(ctx);
    },
  };
  return over.ledger ? { ...built, ledger: over.ledger } : built;
}

async function recordedVersion(): Promise<number> {
  return (await runner.readSchemaState()).version;
}

async function lockHolder(): Promise<string | null> {
  const doc = await db.schemaVersion().findOne({ _id: db.SCHEMA_VERSION_ID });
  return doc?.lock?.holder ?? null;
}

/** The ledger guard only ever counts rows, so these need not be valid MovementDocs. */
async function insertMovements(count: number): Promise<void> {
  await db
    .getDb()
    .collection('movements')
    .insertMany(Array.from({ length: count }, () => ({ _id: new ObjectId(), quantity: 1 })));
}

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });

  process.env.NODE_ENV = 'test';
  process.env.MONGODB_URI = replSet.getUri();
  process.env.MONGODB_DB = 'invintelx_migrations_test';
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

beforeEach(async () => {
  executed = [];
  logged = [];
  await db.schemaVersion().deleteMany({});
  await db.getDb().collection('movements').deleteMany({});
});

describe('running migrations', () => {
  it('runs every migration in version order against an unrecorded database', async () => {
    const result = await runner.runMigrations({
      migrations: [migration(1), migration(2), migration(3)],
      log,
    });

    expect(executed).toEqual(['m1', 'm2', 'm3']);
    expect(result.versionBefore).toBe(0);
    expect(result.versionAfter).toBe(3);
    expect(result.ran).toEqual(['m1', 'm2', 'm3']);
  });

  it('refuses a list whose versions have been renumbered or reordered', async () => {
    await expect(
      runner.runMigrations({ migrations: [migration(2), migration(1)], log }),
    ).rejects.toThrow(/expected version 1/);

    expect(executed).toEqual([]);
    expect(await recordedVersion()).toBe(0);
  });

  it('records what ran, when, and for how long', async () => {
    await runner.runMigrations({ migrations: [migration(1), migration(2)], log });

    const state = await runner.readSchemaState();
    expect(state.version).toBe(2);
    expect(state.applied.map((a) => [a.version, a.name])).toEqual([
      [1, 'm1'],
      [2, 'm2'],
    ]);
    for (const entry of state.applied) {
      expect(entry.appliedAt).toBeInstanceOf(Date);
      expect(entry.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('logs each migration it applies', async () => {
    await runner.runMigrations({ migrations: [migration(1, { name: 'add-widget-field' })], log });

    expect(logged.some((line) => line.includes('applying 1 add-widget-field'))).toBe(true);
    expect(logged.some((line) => line.includes('applied 1 add-widget-field'))).toBe(true);
  });

  it('runs each migration once, no matter how many times the process boots', async () => {
    const migrations = [migration(1), migration(2)];

    await runner.runMigrations({ migrations, log });
    const second = await runner.runMigrations({ migrations, log });

    expect(executed).toEqual(['m1', 'm2']);
    expect(second.ran).toEqual([]);
    expect((await runner.readSchemaState()).applied).toHaveLength(2);
  });

  it('runs only what is outstanding when the database is partway up', async () => {
    await runner.runMigrations({ migrations: [migration(1), migration(2)], log });
    executed = [];

    const result = await runner.runMigrations({
      migrations: [migration(1), migration(2), migration(3), migration(4)],
      log,
    });

    expect(executed).toEqual(['m3', 'm4']);
    expect(result.versionBefore).toBe(2);
    expect(result.versionAfter).toBe(4);
  });
});

describe('a database newer than the code', () => {
  it('refuses to boot', async () => {
    await runner.runMigrations({ migrations: [migration(1), migration(2)], log });

    await expect(runner.runMigrations({ migrations: [migration(1)], log })).rejects.toThrow(
      runner.MigrationError,
    );
  });

  it('says which versions disagree and what to do about it', async () => {
    await runner.runMigrations({ migrations: [migration(1), migration(2), migration(3)], log });

    await expect(
      runner.runMigrations({ migrations: [migration(1)], log }),
    ).rejects.toThrow(/schema version 3.*migrations up to version 1/s);
  });

  it('leaves the recorded version alone rather than winding it back', async () => {
    await runner.runMigrations({ migrations: [migration(1), migration(2)], log });
    executed = [];

    await expect(runner.runMigrations({ migrations: [migration(1)], log })).rejects.toThrow();

    expect(executed).toEqual([]);
    expect(await recordedVersion()).toBe(2);
  });
});

describe('a migration that fails', () => {
  const boom = (): Migration =>
    migration(2, {
      name: 'explodes',
      up: async () => {
        throw new Error('the backfill hit a document it did not expect');
      },
    });

  it('stops the run and does not record itself', async () => {
    await expect(
      runner.runMigrations({ migrations: [migration(1), boom(), migration(3)], log }),
    ).rejects.toThrow('the backfill hit a document it did not expect');

    expect(executed).toEqual(['m1', 'explodes']);
    expect(await recordedVersion()).toBe(1);
  });

  it('releases the lock so the next boot reports the same failure instead of a timeout', async () => {
    await expect(
      runner.runMigrations({ migrations: [migration(1), boom()], log }),
    ).rejects.toThrow();

    expect(await lockHolder()).toBeNull();
  });

  it('is retried from the start on the next boot', async () => {
    await expect(
      runner.runMigrations({ migrations: [migration(1), boom()], log }),
    ).rejects.toThrow();
    executed = [];

    await runner.runMigrations({ migrations: [migration(1), migration(2)], log });

    expect(executed).toEqual(['m2']);
    expect(await recordedVersion()).toBe(2);
  });
});

describe('two processes booting at once', () => {
  it('runs each migration exactly once', async () => {
    const slow = (version: number): Migration =>
      migration(version, {
        up: async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
        },
      });

    const results = await Promise.all([
      runner.runMigrations({ migrations: [slow(1), slow(2)], log, lockPollMs: 10 }),
      runner.runMigrations({ migrations: [slow(1), slow(2)], log, lockPollMs: 10 }),
    ]);

    expect(executed).toEqual(['m1', 'm2']);
    expect(await recordedVersion()).toBe(2);
    expect((await runner.readSchemaState()).applied).toHaveLength(2);
    // Exactly one of them did the work; the other waited and found it done.
    expect(results.flatMap((r) => r.ran)).toEqual(['m1', 'm2']);
    expect(results.filter((r) => r.ran.length === 0)).toHaveLength(1);
  });

  it('gives up rather than booting past a lock that never clears', async () => {
    await db.schemaVersion().insertOne({
      _id: db.SCHEMA_VERSION_ID,
      version: 0,
      applied: [],
      updatedAt: new Date(),
      lock: { holder: 'someone-else', acquiredAt: new Date(), heartbeatAt: new Date() },
    });

    await expect(
      runner.runMigrations({
        migrations: [migration(1)],
        log,
        lockWaitTimeoutMs: 200,
        lockPollMs: 20,
      }),
    ).rejects.toThrow(/Timed out .* waiting for another process/);

    expect(executed).toEqual([]);
  });

  it('takes over a lock whose holder stopped saying it was alive', async () => {
    await db.schemaVersion().insertOne({
      _id: db.SCHEMA_VERSION_ID,
      version: 0,
      applied: [],
      updatedAt: new Date(),
      lock: {
        holder: 'a-process-that-was-killed',
        acquiredAt: new Date(Date.now() - 600_000),
        // Well past the staleness deadline: nobody has been alive here for ten minutes.
        heartbeatAt: new Date(Date.now() - 600_000),
      },
    });

    await runner.runMigrations({ migrations: [migration(1)], log, lockPollMs: 20 });

    expect(executed).toEqual(['m1']);
    expect(await recordedVersion()).toBe(1);
    expect(await lockHolder()).toBeNull();
  });
});

describe('migrations that touch the movement ledger', () => {
  it('lets an additive one through and says what it did to the ledger', async () => {
    await insertMovements(3);

    await runner.runMigrations({
      migrations: [
        migration(1, {
          name: 'backfill-ledger',
          ledger: 'additive',
          up: async () => {
            await insertMovements(2);
          },
        }),
      ],
      log,
    });

    expect(await recordedVersion()).toBe(1);
    expect(logged.some((line) => line.includes('3 -> 5 movements'))).toBe(true);
  });

  it('refuses to record one that declared itself additive and deleted movements', async () => {
    await insertMovements(4);

    await expect(
      runner.runMigrations({
        migrations: [
          migration(1, {
            name: 'drops-history',
            ledger: 'additive',
            up: async ({ db: rawDb }) => {
              await rawDb.collection('movements').deleteMany({});
            },
          }),
        ],
        log,
      }),
    ).rejects.toThrow(/declared itself additive .* removed 4 of 4 movements/s);

    // Unrecorded: the boot fails, loudly, rather than treating the loss as done.
    expect(await recordedVersion()).toBe(0);
  });

  it('does not count the ledger for a migration that never claimed to touch it', async () => {
    await insertMovements(2);

    await runner.runMigrations({ migrations: [migration(1)], log });

    expect(logged.some((line) => line.includes('movement ledger'))).toBe(false);
  });
});

describe('the migration list', () => {
  it('is well formed', () => {
    expect(() => list.assertMigrationsAreWellFormed(list.MIGRATIONS)).not.toThrow();
    expect(list.LATEST_SCHEMA_VERSION).toBe(list.MIGRATIONS.length);
  });

  it('rejects a renumbered or reordered list', () => {
    expect(() => list.assertMigrationsAreWellFormed([migration(1), migration(3)])).toThrow(
      /expected version 2/,
    );
  });

  it('rejects two migrations sharing a name', () => {
    expect(() =>
      list.assertMigrationsAreWellFormed([
        migration(1, { name: 'same' }),
        migration(2, { name: 'same' }),
      ]),
    ).toThrow(/unique/);
  });

  it('leaves a database at the version this build ships', async () => {
    await runner.runMigrations({ log });

    expect(await recordedVersion()).toBe(list.LATEST_SCHEMA_VERSION);
    expect((await runner.readSchemaState()).applied.map((a) => a.name)).toEqual(
      list.MIGRATIONS.map((m) => m.name),
    );
  });
});
