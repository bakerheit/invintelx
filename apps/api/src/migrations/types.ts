import type { Db, MongoClient } from 'mongodb';

/**
 * What a migration is handed. The raw `Db` rather than the typed collection
 * helpers from `db.ts` on purpose: those helpers describe the shape the *current*
 * code expects, and a migration by definition runs against an older one. A
 * migration that reads `items()` is reading through a lie.
 */
export interface MigrationContext {
  db: Db;
  client: MongoClient;
  /** Prefixed and routed the same way the runner's own lines are. */
  log: (message: string) => void;
}

/**
 * How a migration relates to the movement ledger.
 *
 * The ledger is append-only and it is the product's truth — every on-hand
 * figure in the system is derived from it — so a migration that touches it has
 * to say so, and the runner holds it to what it said.
 *
 * 'additive': the migration only adds. Enforced: the runner counts `movements`
 * before and after and fails the run if the count went down, so a migration
 * that quietly drops rows cannot record itself as successful.
 *
 * 'rewrite': the migration changes rows that already exist. Not enforceable
 * from here — no assertion can tell a correct rewrite from a wrong one — so
 * this buys a loud log line and nothing else. Anything declaring it needs a
 * reverse migration written alongside it and a changelog entry that says what
 * it does, because a self-hoster's only copy of their history is going through
 * it. See docs/migrations.md.
 */
export type LedgerImpact = 'additive' | 'rewrite';

export interface Migration {
  /**
   * Contiguous from 1, and frozen once released: the number is what a
   * stranger's database has recorded, so reusing or reordering one silently
   * skips work on every instance that already ran it.
   */
  version: number;
  /** Short and stable. Goes in the boot log and into the version document. */
  name: string;
  /**
   * Omit when the migration does not read or write `movements`. See
   * {@link LedgerImpact}.
   */
  ledger?: LedgerImpact;
  /**
   * Must be safe to run again from the start. Nothing is recorded until `up`
   * returns, so a migration that dies halfway leaves the recorded version
   * untouched and will be retried on the next boot.
   */
  up: (ctx: MigrationContext) => Promise<void>;
}
