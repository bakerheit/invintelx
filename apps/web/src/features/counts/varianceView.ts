import type { CountSheetLine } from '@invintelx/shared';

/**
 * How a variance report is ordered and coloured.
 *
 * Pulled out of the components because getting it wrong is quiet: a report that
 * buries the worst line on page two still looks like a report. No imports worth
 * mocking, so the rules can be checked on their own.
 */

export type LineTone = 'short' | 'over' | 'agreed' | 'uncounted';

export function toneOf(line: Pick<CountSheetLine, 'variance'>): LineTone {
  if (line.variance === null) return 'uncounted';
  if (line.variance === 0) return 'agreed';
  return line.variance > 0 ? 'over' : 'short';
}

/** Badge variants, so short reads as a problem and over reads as a question. */
export const TONE_BADGE: Record<LineTone, 'destructive' | 'warning' | 'success' | 'outline'> = {
  short: 'destructive',
  over: 'warning',
  agreed: 'success',
  uncounted: 'outline',
};

/**
 * The order somebody walks a shelf: by SKU, exactly as the server sent it.
 *
 * Counting is a physical loop past labels in a fixed order, and re-sorting the
 * sheet as numbers are entered would move the next line out from under the
 * finger that is about to tap it.
 */
export function sortForCounting(lines: readonly CountSheetLine[]): CountSheetLine[] {
  return [...lines];
}

const REVIEW_RANK: Record<LineTone, number> = { short: 0, over: 0, uncounted: 1, agreed: 2 };

/**
 * The order somebody reviews a finished sheet: worst first.
 *
 * Differences lead, biggest gap first, because that is the line the argument
 * will be about. Uncounted lines come next — they are unfinished work, not good
 * news — and the lines that agreed go last, where they can be skimmed.
 */
export function sortForReview(lines: readonly CountSheetLine[]): CountSheetLine[] {
  return [...lines].sort((a, b) => {
    const rank = REVIEW_RANK[toneOf(a)] - REVIEW_RANK[toneOf(b)];
    if (rank !== 0) return rank;
    const gap = Math.abs(b.variance ?? 0) - Math.abs(a.variance ?? 0);
    if (gap !== 0) return gap;
    return a.itemSku.localeCompare(b.itemSku);
  });
}

/** Which lines an accept-all control should tick: everything counted. */
export function acceptableLineIds(lines: readonly CountSheetLine[]): string[] {
  return lines.filter((line) => line.countedQuantity !== null).map((line) => line.id);
}

/**
 * What accepting the ticked lines will do, said before it is done.
 *
 * Only the lines that will actually write a movement are counted: ticking a
 * line that agrees changes nothing, and saying "3 adjustments" when one of them
 * is a no-op is the kind of small lie that makes somebody stop reading.
 */
export function acceptSummary(
  lines: readonly CountSheetLine[],
  selected: ReadonlySet<string>,
): { movements: number; netQuantity: number; agreed: number } {
  let movements = 0;
  let netQuantity = 0;
  let agreed = 0;

  for (const line of lines) {
    if (!selected.has(line.id) || line.variance === null) continue;
    if (line.variance === 0) agreed += 1;
    else {
      movements += 1;
      netQuantity += line.variance;
    }
  }

  return { movements, netQuantity, agreed };
}

/** "12 → 9" — the two numbers the whole screen exists to put next to each other. */
export function expectedToCounted(line: Pick<CountSheetLine, 'expectedQuantity' | 'countedQuantity'>): string {
  if (line.countedQuantity === null) return `${line.expectedQuantity.toLocaleString()} → —`;
  return `${line.expectedQuantity.toLocaleString()} → ${line.countedQuantity.toLocaleString()}`;
}

/** Accuracy as a percentage, or a dash while there is nothing to be accurate about. */
export function accuracyLabel(accuracy: number | null): string {
  if (accuracy === null) return '—';
  return `${Math.round(accuracy * 100)}%`;
}
