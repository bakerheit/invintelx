import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import type { Filter } from 'mongodb';
import {
  SCHEMA_VERSION_ID,
  getClient,
  getDb,
  schemaVersion,
  type AppliedMigrationDoc,
  type SchemaVersionDoc,
} from '../db.js';
import { MIGRATIONS, assertMigrationsAreWellFormed } from './list.js';
import { logger } from '../lib/logger.js';
import type { Migration } from './types.js';

/**
 * Ordered, once-only schema migrations with the result written down.
 *
 * `ensureIndexes()` covers indexes and only indexes; it cannot reshape a
 * document, backfill a field or split a collection. That was survivable while
 * we were the only deployment, because we controlled the code and the data
 * together. It stops being survivable the moment somebody else's database is on
 * an older shape and they pull a new tag.
 *
 * Three guarantees, in the order they matter:
 *
 *  - A database newer than the code refuses to boot. Downgrading is the one
 *    upgrade mistake that silently corrupts, because old code writes the old
 *    shape into a collection that has moved on. Better to stop.
 *  - Each migration runs exactly once, in version order, even if two API
 *    processes boot at the same moment. A lock in the version document is what
 *    makes that true rather than merely likely.
 *  - What ran, when, and for how long is kept forever in the version document,
 *    so "which migrations has this instance had" is answerable without guessing
 *    from the data.
 */

/** How often the lock holder says it is still alive. */
const LOCK_HEARTBEAT_MS = 3_000;
/**
 * A lock whose heartbeat stopped this long ago belonged to a process that died.
 * Generous relative to the heartbeat so a slow moment does not hand the lock to
 * a second process while the first is still working.
 */
const LOCK_STALE_AFTER_MS = 30_000;
/** How long to wait for whoever is migrating before giving up on booting. */
const LOCK_WAIT_TIMEOUT_MS = 300_000;
const LOCK_POLL_MS = 500;

/**
 * Anything that should stop the process at boot. Separate from `AppError`,
 * which exists to become an HTTP response — nothing here ever reaches a request.
 */
export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

export interface SchemaState {
  version: number;
  applied: AppliedMigrationDoc[];
}

export interface MigrationRunResult {
  versionBefore: number;
  versionAfter: number;
  /** Names of the migrations this process ran. Empty when there was nothing to do. */
  ran: string[];
  /** True when another process was already migrating and we waited it out. */
  deferredToAnotherProcess: boolean;
}

export interface RunMigrationsOptions {
  /** Overridable so the tests can drive the runner with migrations of their own. */
  migrations?: readonly Migration[];
  log?: (message: string) => void;
  lockWaitTimeoutMs?: number;
  lockPollMs?: number;
}

function defaultLog(message: string): void {
  // Still a line of prose - a migration log is read as a narrative of what the
  // boot did to the database - but carried on a structured record, so a run can
  // be pulled out of a mixed stream by `event: migration`.
  logger.info({ event: 'migration' }, message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}

/** Enough to tell two processes apart in a log line, and nothing sensitive. */
function newHolderId(): string {
  return `${hostname()}/${process.pid}/${randomBytes(3).toString('hex')}`;
}

/** What the database says about itself. Absent document means nothing has run. */
export async function readSchemaState(): Promise<SchemaState> {
  const doc = await schemaVersion().findOne({ _id: SCHEMA_VERSION_ID });
  return { version: doc?.version ?? 0, applied: doc?.applied ?? [] };
}

function assertDatabaseIsNotNewerThanCode(dbVersion: number, codeVersion: number): void {
  if (dbVersion <= codeVersion) return;
  throw new MigrationError(
    `This database is at schema version ${dbVersion}, but this build only knows migrations up ` +
      `to version ${codeVersion}. It was migrated by a newer release of InvIntelX, and running ` +
      `older code against it would write the old shape back into collections that have moved ` +
      `on. Deploy the newer release again, or restore the backup taken before the upgrade.`,
  );
}

/** The version document, but only while this process is the one holding the lock. */
function lockedBy(holder: string): Filter<SchemaVersionDoc> {
  return { _id: SCHEMA_VERSION_ID, 'lock.holder': holder } as unknown as Filter<SchemaVersionDoc>;
}

/**
 * Take the lock, returning when it was taken, or null if somebody else has it.
 *
 * The upsert is the whole mechanism. If the document is absent it is created
 * with the lock already held; if it exists and is unlocked (or the holder's
 * heartbeat has stopped) the filter matches and we take it; if it exists and is
 * genuinely held the filter misses, Mongo tries to insert instead, and the
 * unique `_id` rejects it. A duplicate key here is not an error — it is the
 * answer.
 */
async function acquireLock(holder: string): Promise<Date | null> {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - LOCK_STALE_AFTER_MS);
  const unheldOrAbandoned = {
    _id: SCHEMA_VERSION_ID,
    $or: [{ lock: null }, { 'lock.heartbeatAt': { $lte: staleBefore } }],
  } as unknown as Filter<SchemaVersionDoc>;

  try {
    const result = await schemaVersion().findOneAndUpdate(
      unheldOrAbandoned,
      {
        $set: { lock: { holder, acquiredAt: now, heartbeatAt: now }, updatedAt: now },
        $setOnInsert: { version: 0, applied: [] },
      },
      { upsert: true, returnDocument: 'after' },
    );
    return result === null ? null : now;
  } catch (err) {
    if (isDuplicateKey(err)) return null;
    throw err;
  }
}

/**
 * Keep saying we are alive for as long as the migration runs, so a lock left by
 * a killed process can be distinguished from one that is still working. A
 * missed beat is harmless — it only brings the staleness deadline closer — so
 * failures here are swallowed rather than allowed to abort a migration.
 *
 * This rides on the event loop, so it cannot help a migration that blocks it.
 * Migrations are database work and do not, but one that decided to do a long
 * synchronous computation would look dead while it was thinking.
 */
function startHeartbeat(holder: string, acquiredAt: Date): () => void {
  const timer = setInterval(() => {
    void schemaVersion()
      .updateOne(lockedBy(holder), {
        $set: { lock: { holder, acquiredAt, heartbeatAt: new Date() } },
      })
      .catch(() => {});
  }, LOCK_HEARTBEAT_MS);
  timer.unref();
  return () => clearInterval(timer);
}

async function releaseLock(holder: string): Promise<void> {
  await schemaVersion().updateOne(lockedBy(holder), {
    $set: { lock: null, updatedAt: new Date() },
  });
}

async function countMovements(): Promise<number> {
  return getDb().collection('movements').countDocuments({});
}

/**
 * Run one migration and record it, in that order. Nothing is written to the
 * version document until `up` has returned and any ledger guarantee has been
 * checked, so a migration that throws leaves the recorded version where it was
 * and will be retried on the next boot — which is why migrations have to be
 * safe to re-run from the start.
 */
async function applyMigration(migration: Migration, log: (m: string) => void): Promise<void> {
  const startedAt = Date.now();
  log(`applying ${migration.version} ${migration.name}`);

  // Counted before `up`, not after a failure, so the comparison below is against
  // the ledger as it actually was when this migration started.
  const movementsBefore = migration.ledger ? await countMovements() : null;
  if (migration.ledger !== undefined && movementsBefore !== null) {
    log(
      `  touches the movement ledger (${migration.ledger}); ${movementsBefore} movements on record`,
    );
  }

  await migration.up({
    db: getDb(),
    client: getClient(),
    log: (message) => log(`  ${message}`),
  });

  if (migration.ledger === 'additive' && movementsBefore !== null) {
    const movementsAfter = await countMovements();
    if (movementsAfter < movementsBefore) {
      throw new MigrationError(
        `Migration ${migration.version} (${migration.name}) declared itself additive to the ` +
          `movement ledger but removed ${movementsBefore - movementsAfter} of ${movementsBefore} ` +
          `movements. The ledger is append-only and is the only record of what this instance ` +
          `has ever done, so this migration has not been recorded and boot is aborted. The ` +
          `database is mid-migration: restore from backup before running anything against it.`,
      );
    }
    log(`  ledger additive check passed: ${movementsBefore} -> ${movementsAfter} movements`);
  }

  const durationMs = Date.now() - startedAt;
  const record: AppliedMigrationDoc = {
    version: migration.version,
    name: migration.name,
    appliedAt: new Date(),
    durationMs,
  };

  // Guarded on the previous version rather than on `_id` alone: if anything has
  // moved the recorded version under us, this migration's result is not what we
  // think it is and silently overwriting the number would hide that.
  const recorded = await schemaVersion().updateOne(
    { _id: SCHEMA_VERSION_ID, version: migration.version - 1 },
    {
      $set: { version: migration.version, updatedAt: record.appliedAt },
      $push: { applied: record },
    },
  );
  if (recorded.matchedCount !== 1) {
    throw new MigrationError(
      `Migration ${migration.version} (${migration.name}) ran, but the recorded schema version ` +
        `was no longer ${migration.version - 1} when it finished. Another process is writing to ` +
        `this database's version document. Stop every InvIntelX instance and inspect it before ` +
        `booting again.`,
    );
  }

  log(`applied ${migration.version} ${migration.name} in ${durationMs}ms`);
}

/**
 * Bring the database up to what this build expects. Call before anything reads
 * or writes application data — a boot that continues past a failure here is a
 * boot that runs new code against an old shape.
 */
export async function runMigrations(
  options: RunMigrationsOptions = {},
): Promise<MigrationRunResult> {
  const migrations = options.migrations ?? MIGRATIONS;
  const log = options.log ?? defaultLog;
  const waitTimeoutMs = options.lockWaitTimeoutMs ?? LOCK_WAIT_TIMEOUT_MS;
  const pollMs = options.lockPollMs ?? LOCK_POLL_MS;

  // Cheap, and the failure it catches — a renumbered or duplicated migration —
  // is one that would otherwise be discovered on somebody else's database.
  assertMigrationsAreWellFormed(migrations);
  const codeVersion = migrations.reduce((highest, m) => Math.max(highest, m.version), 0);

  const before = await readSchemaState();
  assertDatabaseIsNotNewerThanCode(before.version, codeVersion);

  if (before.version === codeVersion) {
    log(`database is at schema version ${codeVersion}; nothing to run`);
    return {
      versionBefore: before.version,
      versionAfter: before.version,
      ran: [],
      deferredToAnotherProcess: false,
    };
  }

  const holder = newHolderId();
  const deadline = Date.now() + waitTimeoutMs;
  let waited = false;
  let acquiredAt = await acquireLock(holder);

  while (acquiredAt === null) {
    if (!waited) log('another process is migrating this database; waiting');
    waited = true;
    const current = await readSchemaState();
    // The other process may be a *newer* build mid-rolling-deploy, in which case
    // it is about to leave this database ahead of us and we must not boot.
    assertDatabaseIsNotNewerThanCode(current.version, codeVersion);
    if (current.version === codeVersion) {
      log(`another process migrated this database to version ${codeVersion}`);
      return {
        versionBefore: before.version,
        versionAfter: current.version,
        ran: [],
        deferredToAnotherProcess: true,
      };
    }
    if (Date.now() >= deadline) {
      throw new MigrationError(
        `Timed out after ${Math.round(waitTimeoutMs / 1000)}s waiting for another process to ` +
          `finish migrating this database. It is still at schema version ${current.version}, on ` +
          `its way to ${codeVersion}. If no other InvIntelX instance is running, a previous one ` +
          `was killed mid-migration: check the version document in the schemaVersion collection.`,
      );
    }
    await sleep(pollMs);
    acquiredAt = await acquireLock(holder);
  }

  const stopHeartbeat = startHeartbeat(holder, acquiredAt);
  const ran: string[] = [];

  try {
    // Re-read under the lock. Between the first read and taking the lock, another
    // process may have run some or all of this.
    const current = await readSchemaState();
    assertDatabaseIsNotNewerThanCode(current.version, codeVersion);

    // Already in version order: `assertMigrationsAreWellFormed` above is what
    // guarantees array position and version agree, so filtering preserves it.
    const pending = migrations.filter((migration) => migration.version > current.version);

    if (pending.length === 0) {
      log(`database is at schema version ${current.version}; nothing to run`);
      return {
        versionBefore: before.version,
        versionAfter: current.version,
        ran: [],
        deferredToAnotherProcess: waited,
      };
    }

    log(
      `migrating from version ${current.version} to ${codeVersion} (${pending.length} to run)` +
        (waited ? ' after waiting for another process' : ''),
    );

    for (const migration of pending) {
      await applyMigration(migration, log);
      ran.push(migration.name);
    }

    const after = await readSchemaState();
    log(`database is now at schema version ${after.version}`);
    return {
      versionBefore: before.version,
      versionAfter: after.version,
      ran,
      deferredToAnotherProcess: waited,
    };
  } finally {
    stopHeartbeat();
    // Released even on failure: the lock says "a process is working", and this
    // one has stopped. Leaving it held would make the next boot wait five
    // minutes for a process that is already dead before reporting the same
    // problem, only later and less clearly.
    await releaseLock(holder).catch(() => {});
  }
}
