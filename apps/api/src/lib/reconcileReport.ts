/**
 * Turns a projection check into something an operator can read at 3am on a
 * machine they have just restored.
 *
 * Kept apart from the command that prints it so the wording can be tested
 * without running a process, and so `reconcile.ts` stays a script rather than a
 * script with a formatter hidden inside it.
 */
import type { StockLevelDiscrepancy, StockLevelVerification } from '../db.js';

/** Past this many rows the list stops being a report and becomes a dump. */
const MAX_ROWS = 20;

/** The projection has no row at all for a pair, or the ledger has no movements. */
const ABSENT = '(none)';

export function isClean(verification: StockLevelVerification): boolean {
  return verification.discrepancies.length === 0;
}

/**
 * The three shapes a disagreement comes in. They mean different things after a
 * restore, so counting them separately is the difference between "your dump was
 * torn" and "somebody edited on-hand by hand".
 */
export function countKinds(discrepancies: StockLevelDiscrepancy[]): {
  wrong: number;
  missing: number;
  unknownToLedger: number;
} {
  let wrong = 0;
  let missing = 0;
  let unknownToLedger = 0;

  for (const d of discrepancies) {
    if (d.stored === null) missing += 1;
    else if (d.ledger === null) unknownToLedger += 1;
    else wrong += 1;
  }

  return { wrong, missing, unknownToLedger };
}

function table(discrepancies: StockLevelDiscrepancy[]): string[] {
  const shown = discrepancies.slice(0, MAX_ROWS);
  const rows = shown.map((d) => ({
    location: d.locationCode || ABSENT,
    item: d.itemId.toHexString(),
    stored: d.stored === null ? ABSENT : String(d.stored),
    ledger: d.ledger === null ? ABSENT : String(d.ledger),
  }));

  const header = { location: 'location', item: 'item', stored: 'stored', ledger: 'ledger' };
  const width = (pick: (row: typeof header) => string): number =>
    Math.max(pick(header).length, ...rows.map((row) => pick(row).length));

  const locationWidth = width((row) => row.location);
  const itemWidth = width((row) => row.item);
  const storedWidth = width((row) => row.stored);
  const ledgerWidth = width((row) => row.ledger);

  const line = (row: typeof header): string =>
    `  ${row.location.padEnd(locationWidth)}  ${row.item.padEnd(itemWidth)}  ` +
    `${row.stored.padStart(storedWidth)}  ${row.ledger.padStart(ledgerWidth)}`;

  const lines = [line(header), ...rows.map(line)];
  const hidden = discrepancies.length - shown.length;
  if (hidden > 0) lines.push(`  ... and ${hidden} more`);

  return lines;
}

/**
 * The whole report, as lines. Ends without a trailing blank so the caller
 * decides the spacing.
 */
export function formatVerification(verification: StockLevelVerification): string[] {
  const { movements, expectedLevels, storedLevels, discrepancies } = verification;

  if (isClean(verification)) {
    return [
      'The projection matches the ledger.',
      `  ${movements} movements`,
      `  ${storedLevels} on-hand figures, every one of them re-derived and identical`,
    ];
  }

  const { wrong, missing, unknownToLedger } = countKinds(discrepancies);

  return [
    `The projection does NOT match the ledger — ${discrepancies.length} disagreements.`,
    `  ${movements} movements`,
    `  ledger implies ${expectedLevels} on-hand figures; the projection holds ${storedLevels} rows`,
    `  ${wrong} wrong, ${missing} missing from the projection, ${unknownToLedger} not in the ledger`,
    '',
    ...table(discrepancies),
  ];
}

/**
 * What to do about it. Separate from the report because after a rebuild the same
 * numbers mean something different: a disagreement that survives a rebuild is
 * not a stale projection, it is a bug or a concurrent writer.
 */
export function advice(verification: StockLevelVerification, rebuilt: boolean): string[] {
  if (isClean(verification)) {
    return rebuilt
      ? ['The rebuild is written and the numbers check out.']
      : [
          'Nothing was written — this command only read.',
          'On a restored database this is the answer you want: the ledger and the',
          'on-hand figures in the snapshot still agree, so the snapshot was taken',
          'consistently. It does not prove the snapshot is up to date; nothing',
          'inside a restored database can tell you what happened after the dump.',
        ];
  }

  return rebuilt
    ? [
        'These survived a rebuild, which a stale projection cannot do. Something is',
        'writing on-hand while this ran, or the ledger is being read differently from',
        'the way it is written. Do not paper over it with another rebuild.',
      ]
    : [
        'Nothing was written — this command only read.',
        'On a freshly restored database this usually means the dump was torn: the',
        'ledger and the projection were read at different moments, so a movement',
        'landed in one and not the other. Take the dump again with --oplog, or with',
        'the writers stopped, and see docs/backup-and-restore.md.',
        '',
        'If you accept the restored ledger as the truth, `pnpm db:rebuild` recomputes',
        'on-hand from it. That repairs the numbers and destroys the evidence, so read',
        'the list above first.',
      ];
}
