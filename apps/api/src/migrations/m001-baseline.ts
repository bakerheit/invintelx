import type { Migration } from './types.js';

/**
 * The schema as it stood when migrations were introduced.
 *
 * It does nothing, and that is the point. Every database in existence at this
 * moment — a fresh one, and the one running invintelx.org — is already in this
 * shape, so version 1 is the shared starting line that later migrations can be
 * ordered against. Without it "unmigrated" and "up to date" are the same
 * recorded state, and the first real migration has no way to tell a pre-existing
 * database from an empty one.
 *
 * Collections and indexes are deliberately not created here: `ensureIndexes()`
 * runs at boot and is idempotent, which already covers them.
 */
export const m001Baseline: Migration = {
  version: 1,
  name: 'baseline',
  up: async ({ log }) => {
    log('baseline: recording the pre-migration schema as version 1; nothing to change');
  },
};
