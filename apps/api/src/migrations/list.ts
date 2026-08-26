import { m001Baseline } from './m001-baseline.js';
import type { Migration } from './types.js';

/**
 * Every migration, in the order they run. Append only — never insert, renumber
 * or delete, because these numbers are recorded in other people's databases.
 *
 * `assertMigrationsAreWellFormed` is called on import rather than left to a
 * test, so a mistake here fails at boot on the machine that made it instead of
 * halfway through a stranger's upgrade.
 */
export const MIGRATIONS: readonly Migration[] = [m001Baseline];

/** What version a database is expected to be at once this build has booted. */
export const LATEST_SCHEMA_VERSION: number = MIGRATIONS.reduce(
  (highest, migration) => Math.max(highest, migration.version),
  0,
);

export function assertMigrationsAreWellFormed(migrations: readonly Migration[]): void {
  const names = new Set<string>();

  migrations.forEach((migration, index) => {
    const expected = index + 1;
    if (migration.version !== expected) {
      throw new Error(
        `Migration list is out of order: expected version ${expected} at position ${index}, got ` +
          `${migration.version} (${migration.name}). Versions must run 1..n with no gaps.`,
      );
    }
    if (names.has(migration.name)) {
      throw new Error(`Two migrations are called "${migration.name}". Names have to be unique.`);
    }
    names.add(migration.name);
  });
}

assertMigrationsAreWellFormed(MIGRATIONS);
