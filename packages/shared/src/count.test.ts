import { describe, expect, it } from 'vitest';
import {
  createCountSheetInputSchema,
  countedQuantitySchema,
  lineVariance,
  postCountSheetInputSchema,
  recordCountInputSchema,
  summariseCountSheet,
  varianceHeadline,
  varianceLabel,
} from './count.js';

const line = (expectedQuantity: number, countedQuantity: number | null) => ({
  expectedQuantity,
  countedQuantity,
});

describe('lineVariance', () => {
  it('is counted minus expected', () => {
    expect(lineVariance(line(10, 8))).toBe(-2);
    expect(lineVariance(line(10, 13))).toBe(3);
  });

  it('is zero when the shelf agrees with the books', () => {
    expect(lineVariance(line(10, 10))).toBe(0);
  });

  it('is null while nobody has counted, and never zero', () => {
    expect(lineVariance(line(10, null))).toBeNull();
  });

  it('tells counting zero apart from not counting', () => {
    expect(lineVariance(line(4, 0))).toBe(-4);
    expect(lineVariance(line(4, null))).toBeNull();
  });
});

describe('summariseCountSheet', () => {
  it('counts an empty sheet without claiming perfection', () => {
    const summary = summariseCountSheet([]);
    expect(summary.lineCount).toBe(0);
    expect(summary.countedCount).toBe(0);
    expect(summary.accuracy).toBeNull();
  });

  it('leaves accuracy null until something is counted', () => {
    expect(summariseCountSheet([line(5, null), line(6, null)]).accuracy).toBeNull();
  });

  it('splits counted from uncounted', () => {
    const summary = summariseCountSheet([line(5, 5), line(6, null), line(7, 4)]);
    expect(summary.lineCount).toBe(3);
    expect(summary.countedCount).toBe(2);
    expect(summary.uncountedCount).toBe(1);
  });

  it('separates short from over', () => {
    const summary = summariseCountSheet([line(10, 7), line(4, 9), line(2, 2)]);
    expect(summary.shortCount).toBe(1);
    expect(summary.overCount).toBe(1);
    expect(summary.agreedCount).toBe(1);
    expect(summary.varianceCount).toBe(2);
  });

  it('reports net and absolute variance separately', () => {
    // Five over on one line and five short on another is ten units of error,
    // not none. Netting them to zero is how counting stops meaning anything.
    const summary = summariseCountSheet([line(10, 15), line(10, 5)]);
    expect(summary.netVariance).toBe(0);
    expect(summary.absVariance).toBe(10);
    expect(summary.varianceCount).toBe(2);
  });

  it('measures accuracy against counted lines, not against every line', () => {
    // Three counted, two agreed. The uncounted line is not evidence either way.
    const summary = summariseCountSheet([line(1, 1), line(2, 2), line(3, 9), line(4, null)]);
    expect(summary.accuracy).toBeCloseTo(2 / 3);
  });

  it('is 1 when every counted line agrees', () => {
    expect(summariseCountSheet([line(1, 1), line(2, 2)]).accuracy).toBe(1);
  });

  it('ignores uncounted lines in the totals', () => {
    const summary = summariseCountSheet([line(100, null), line(3, 1)]);
    expect(summary.netVariance).toBe(-2);
    expect(summary.absVariance).toBe(2);
  });
});

describe('varianceHeadline', () => {
  it('says nothing has been counted rather than reporting a clean sheet', () => {
    expect(varianceHeadline(summariseCountSheet([line(5, null)]))).toBe('Nothing counted yet');
  });

  it('says everything agrees when it does', () => {
    expect(varianceHeadline(summariseCountSheet([line(5, 5), line(6, 6)]))).toBe(
      'All 2 counted lines agree',
    );
  });

  it('reads as one line for a single agreeing line', () => {
    expect(varianceHeadline(summariseCountSheet([line(5, 5)]))).toBe('All 1 counted line agrees');
  });

  it('leads with short, then over, then the units out', () => {
    expect(varianceHeadline(summariseCountSheet([line(10, 5), line(4, 9)]))).toBe(
      '1 short, 1 over · 10 units out',
    );
  });

  it('omits the side that has nothing on it', () => {
    expect(varianceHeadline(summariseCountSheet([line(10, 5)]))).toBe('1 short · 5 units out');
    expect(varianceHeadline(summariseCountSheet([line(10, 12)]))).toBe('1 over · 2 units out');
  });
});

describe('varianceLabel', () => {
  it('names the direction in the words used in an aisle', () => {
    expect(varianceLabel(-3)).toBe('3 short');
    expect(varianceLabel(2)).toBe('2 over');
    expect(varianceLabel(0)).toBe('Agrees');
    expect(varianceLabel(null)).toBe('Not counted');
  });
});

describe('input schemas', () => {
  it('refuses a negative counted quantity', () => {
    expect(countedQuantitySchema.safeParse(-1).success).toBe(false);
    expect(countedQuantitySchema.safeParse(0).success).toBe(true);
  });

  it('refuses a fractional count', () => {
    expect(countedQuantitySchema.safeParse(2.5).success).toBe(false);
  });

  it('accepts null as clearing a count', () => {
    expect(recordCountInputSchema.parse({ countedQuantity: null }).countedQuantity).toBeNull();
  });

  it('defaults a sheet to the whole bin', () => {
    const parsed = createCountSheetInputSchema.parse({
      locationId: '0123456789abcdef01234567',
    });
    expect(parsed.itemIds).toEqual([]);
    expect(parsed.note).toBe('');
  });

  it('refuses a post with no lines accepted', () => {
    expect(postCountSheetInputSchema.safeParse({ lineIds: [] }).success).toBe(false);
  });
});
