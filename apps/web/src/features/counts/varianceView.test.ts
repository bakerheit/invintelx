import { describe, expect, it } from 'vitest';
import type { CountSheetLine } from '@invintelx/shared';
import {
  acceptSummary,
  acceptableLineIds,
  accuracyLabel,
  expectedToCounted,
  sortForReview,
  toneOf,
} from './varianceView';

function line(overrides: Partial<CountSheetLine> & { id: string }): CountSheetLine {
  return {
    itemId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    itemSku: `SKU-${overrides.id}`,
    itemName: 'Something',
    expectedQuantity: 10,
    countedQuantity: null,
    variance: null,
    countedAt: null,
    countedByName: '',
    postedMovementId: null,
    postedQuantity: null,
    ...overrides,
  };
}

/** Counted lines carry a variance; the pair always moves together. */
function counted(id: string, expected: number, count: number, sku?: string): CountSheetLine {
  return line({
    id,
    ...(sku ? { itemSku: sku } : {}),
    expectedQuantity: expected,
    countedQuantity: count,
    variance: count - expected,
  });
}

describe('toneOf', () => {
  it('tells the four states apart', () => {
    expect(toneOf({ variance: -2 })).toBe('short');
    expect(toneOf({ variance: 3 })).toBe('over');
    expect(toneOf({ variance: 0 })).toBe('agreed');
    expect(toneOf({ variance: null })).toBe('uncounted');
  });
});

describe('sortForReview', () => {
  it('puts the biggest difference first', () => {
    const sorted = sortForReview([counted('a', 10, 9), counted('b', 10, 2), counted('c', 10, 12)]);
    expect(sorted.map((l) => l.id)).toEqual(['b', 'c', 'a']);
  });

  it('ranks short and over together, by size rather than by direction', () => {
    // A bin five over is as wrong as a bin five short, and hiding one below the
    // other would make an over look like the lesser problem.
    const sorted = sortForReview([counted('short1', 10, 9), counted('over5', 10, 15)]);
    expect(sorted.map((l) => l.id)).toEqual(['over5', 'short1']);
  });

  it('puts uncounted lines above lines that agree', () => {
    const sorted = sortForReview([counted('agrees', 10, 10), line({ id: 'blank' })]);
    expect(sorted.map((l) => l.id)).toEqual(['blank', 'agrees']);
  });

  it('leads with differences, then unfinished work, then the boring lines', () => {
    const sorted = sortForReview([
      counted('agrees', 5, 5),
      line({ id: 'blank' }),
      counted('wrong', 5, 1),
    ]);
    expect(sorted.map((l) => l.id)).toEqual(['wrong', 'blank', 'agrees']);
  });

  it('breaks ties by SKU so two runs read the same', () => {
    const sorted = sortForReview([
      counted('x', 10, 8, 'ZETA-1'),
      counted('y', 10, 8, 'ALPHA-1'),
    ]);
    expect(sorted.map((l) => l.itemSku)).toEqual(['ALPHA-1', 'ZETA-1']);
  });

  it('does not mutate what it was given', () => {
    const lines = [counted('a', 10, 10), counted('b', 10, 1)];
    sortForReview(lines);
    expect(lines.map((l) => l.id)).toEqual(['a', 'b']);
  });
});

describe('acceptableLineIds', () => {
  it('offers every counted line and no uncounted one', () => {
    expect(acceptableLineIds([counted('a', 5, 5), line({ id: 'b' }), counted('c', 5, 1)])).toEqual([
      'a',
      'c',
    ]);
  });
});

describe('acceptSummary', () => {
  it('counts only the lines that will write something', () => {
    const lines = [counted('a', 10, 7), counted('b', 10, 10), counted('c', 10, 12)];
    const summary = acceptSummary(lines, new Set(['a', 'b', 'c']));
    expect(summary.movements).toBe(2);
    expect(summary.agreed).toBe(1);
    expect(summary.netQuantity).toBe(-1);
  });

  it('ignores lines nobody ticked', () => {
    const lines = [counted('a', 10, 7), counted('b', 10, 1)];
    expect(acceptSummary(lines, new Set(['a'])).movements).toBe(1);
    expect(acceptSummary(lines, new Set(['a'])).netQuantity).toBe(-3);
  });

  it('ignores an uncounted line even when it is ticked', () => {
    const summary = acceptSummary([line({ id: 'blank' })], new Set(['blank']));
    expect(summary).toEqual({ movements: 0, netQuantity: 0, agreed: 0 });
  });
});

describe('expectedToCounted', () => {
  it('shows both numbers side by side', () => {
    expect(expectedToCounted({ expectedQuantity: 12, countedQuantity: 9 })).toBe('12 → 9');
  });

  it('shows a dash rather than a zero for an uncounted line', () => {
    expect(expectedToCounted({ expectedQuantity: 12, countedQuantity: null })).toBe('12 → —');
  });

  it('shows a counted zero as a zero', () => {
    expect(expectedToCounted({ expectedQuantity: 12, countedQuantity: 0 })).toBe('12 → 0');
  });
});

describe('accuracyLabel', () => {
  it('rounds to a whole percent', () => {
    expect(accuracyLabel(2 / 3)).toBe('67%');
    expect(accuracyLabel(1)).toBe('100%');
  });

  it('will not print a percentage for nothing counted', () => {
    expect(accuracyLabel(null)).toBe('—');
  });
});
