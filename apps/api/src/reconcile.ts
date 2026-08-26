/**
 * Checks the on-hand projection against the movement ledger, and rebuilds it
 * when asked.
 *
 * This is the last step of a restore. Everything else in a restore tells you a
 * process exited zero; this tells you the data agrees with itself.
 *
 *   pnpm db:verify    read only, exits 1 if the projection disagrees
 *   pnpm db:rebuild   check, recompute on-hand from the ledger, check again
 *
 * Deliberately does not run migrations or create indexes. Checking a database
 * should not change its shape, and a restored snapshot is exactly the case where
 * you want to see what is there rather than what boot would have made of it.
 *
 * Exit codes, because something will eventually run this from cron:
 *   0  the projection matches the ledger
 *   1  it does not, or the database could not be reached
 *   2  the arguments were wrong
 */
import { connect, disconnect, rebuildStockLevels, verifyStockLevels } from './db.js';
import { env } from './env.js';
import { advice, formatVerification, isClean } from './lib/reconcileReport.js';

const USAGE = `Usage: reconcile [--rebuild]

  (no arguments)  compare the on-hand projection with the ledger and report. Writes nothing.
  --rebuild       do that, then recompute on-hand from the ledger, then compare again.`;

function say(lines: string[]): void {
  for (const line of lines) console.log(line);
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    return 0;
  }

  const rebuild = args.includes('--rebuild');
  const unknown = args.filter((arg) => arg !== '--rebuild');

  if (unknown.length > 0) {
    console.error(`Unrecognised argument: ${unknown.join(' ')}\n\n${USAGE}`);
    return 2;
  }

  await connect();
  try {
    // The password, if there is one, has no business in a log an operator is
    // about to paste into an issue.
    console.log(`Reading ${env.MONGODB_DB} at ${env.MONGODB_URI.replace(/\/\/[^@]*@/, '//***@')}`);
    console.log('');

    const before = await verifyStockLevels();
    say(formatVerification(before));

    if (!rebuild) {
      console.log('');
      say(advice(before, false));
      return isClean(before) ? 0 : 1;
    }

    console.log('');
    console.log('Rebuilding on-hand from the ledger...');
    const result = await rebuildStockLevels();
    console.log(`  ${result.levels} on-hand figures written from ${result.movements} movements`);
    console.log('');

    const after = await verifyStockLevels();
    say(formatVerification(after));
    console.log('');
    say(advice(after, true));
    return isClean(after) ? 0 : 1;
  } finally {
    await disconnect();
  }
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((err: unknown) => {
    console.error('Could not check the projection:', err);
    process.exit(1);
  });
