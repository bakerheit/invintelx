import { describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import { DAYS_PER_YEAR, DEFAULT_ABC_A_PERCENT, DEFAULT_ABC_B_PERCENT } from '@invintelx/shared';
// From the pure module deliberately: importing analytics.js would pull in
// db.js and its env parsing, which is what broke CI once already.
import { annualUnitsFrom, bandFor, classifyAbc, summariseAbc } from './abc.js';
import type { AbcInput } from './abc.js';
import type { ItemDoc } from '../db.js';

function item(sku: string, unitCostCents: number): ItemDoc {
  return {
    _id: new ObjectId(),
    sku,
    name: `Item ${sku}`,
    description: '',
    category: '',
    unitOfMeasure: 'each',
    barcode: '',
    unitCostCents,
    unitPriceCents: unitCostCents * 2,
    reorderPoint: 20,
    reorderQuantity: 100,
    status: 'active',
    attributes: {},
    createdAt: new Date('2025-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-03-10T12:00:00.000Z'),
  };
}

/**
 * A catalogue described as "SKU, unit cost, units issued", which is the whole
 * input to the classification.
 */
function inputs(rows: [sku: string, unitCostCents: number, unitsIssued: number][]): AbcInput[] {
  return rows.map(([sku, cost, issued]) => ({ item: item(sku, cost), unitsIssued: issued }));
}

const BANDS = { aPercent: DEFAULT_ABC_A_PERCENT, bPercent: DEFAULT_ABC_B_PERCENT };

/** A year-long window, so annualising is the identity and the sums stay readable. */
const YEAR = { windowDays: DAYS_PER_YEAR, ...BANDS };

describe('annualUnitsFrom', () => {
  it('extrapolates a window to a full year', () => {
    // A fifth of a year at 100 units is 500 a year.
    expect(annualUnitsFrom(100, 73)).toBe(500);
  });

  it('leaves a year-long window alone', () => {
    expect(annualUnitsFrom(500, DAYS_PER_YEAR)).toBe(500);
  });

  it('does not divide by a zero-length window', () => {
    expect(annualUnitsFrom(100, 0)).toBe(0);
  });
});

describe('bandFor', () => {
  it('puts the top of the ranking in A even when it alone exceeds the A cut', () => {
    // One SKU that is 90% of spend starts at a cumulative share of zero. Testing
    // the share after it would band it B and leave A empty.
    expect(bandFor(90_000, 0, 80, 95)).toBe('A');
  });

  it('bands by the share accumulated above the row, not including it', () => {
    expect(bandFor(1000, 0.79, 80, 95)).toBe('A');
    expect(bandFor(1000, 0.8, 80, 95)).toBe('B');
    expect(bandFor(1000, 0.94, 80, 95)).toBe('B');
    expect(bandFor(1000, 0.95, 80, 95)).toBe('C');
  });

  it('bands anything that consumed nothing as C, wherever it sits', () => {
    expect(bandFor(0, 0, 80, 95)).toBe('C');
  });
});

describe('classifyAbc', () => {
  it('ranks by annual consumption value, not by units and not by unit cost', () => {
    // CHEAP moves ten times the units; DEAR is worth a hundred times more each.
    const rows = classifyAbc(inputs([
      ['CHEAP', 10, 1000],
      ['DEAR', 1000, 100],
    ]), YEAR);

    expect(rows.map((r) => r.sku)).toEqual(['DEAR', 'CHEAP']);
    expect(rows[0]).toMatchObject({
      sku: 'DEAR',
      rank: 1,
      unitsIssued: 100,
      annualUnits: 100,
      annualConsumptionValueCents: 100_000,
    });
    expect(rows[1]).toMatchObject({ sku: 'CHEAP', rank: 2, annualConsumptionValueCents: 10_000 });
  });

  it('annualises a short window before comparing', () => {
    // 90 days of 90 units is 365 a year, at 100 cents each.
    const rows = classifyAbc(inputs([['A-1', 100, 90]]), { windowDays: 90, ...BANDS });

    expect(rows[0]?.annualUnits).toBeCloseTo(365, 6);
    expect(rows[0]?.annualConsumptionValueCents).toBe(36_500);
  });

  it('cuts the catalogue at 80 and 95 percent of value', () => {
    // Values 85, 12 and 3 of a total of 100. Fed in out of order, because the
    // ranking is the classifier's job and not the caller's.
    const rows = classifyAbc(inputs([
      ['B-1', 1, 12],
      ['C-1', 1, 3],
      ['A-1', 1, 85],
    ]), YEAR);

    expect(rows.map((r) => [r.sku, r.band])).toEqual([
      ['A-1', 'A'],
      ['B-1', 'B'],
      ['C-1', 'C'],
    ]);
  });

  it('lands a catalogue sitting exactly on both cuts in one band each', () => {
    // 80 / 15 / 5. Every cumulative share is exactly a cut, which is where
    // scaling the share up to a percentage instead of the cut down to a
    // fraction rounds B into A and C into B.
    const rows = classifyAbc(inputs([
      ['A-1', 1, 80],
      ['B-1', 1, 15],
      ['C-1', 1, 5],
    ]), YEAR);

    expect(rows.map((r) => r.band)).toEqual(['A', 'B', 'C']);
  });

  it('honours non-default cuts', () => {
    const rows = classifyAbc(inputs([
      ['ONE', 1, 50],
      ['TWO', 1, 30],
      ['THREE', 1, 20],
    ]), { windowDays: DAYS_PER_YEAR, aPercent: 50, bPercent: 60 });

    // ONE starts at 0% so it is A. TWO starts at 50%, which is no longer below
    // the A cut but is below the B cut. THREE starts at 80% and falls out.
    expect(rows.map((r) => r.band)).toEqual(['A', 'B', 'C']);
  });

  it('reports shares that accumulate to the whole', () => {
    const rows = classifyAbc(inputs([
      ['A-1', 1, 60],
      ['B-1', 1, 40],
    ]), YEAR);

    expect(rows[0]?.valueShare).toBeCloseTo(0.6, 6);
    expect(rows[0]?.cumulativeValueShare).toBeCloseTo(0.6, 6);
    expect(rows[1]?.cumulativeValueShare).toBeCloseTo(1, 6);
  });

  it('bands a catalogue that has consumed nothing entirely as C', () => {
    // Every cumulative share is zero here, so a rule that only looked at the
    // share would grade a warehouse where nothing moved as all-A.
    const rows = classifyAbc(inputs([
      ['X-1', 500, 0],
      ['X-2', 900, 0],
    ]), YEAR);

    expect(rows.map((r) => r.band)).toEqual(['C', 'C']);
    expect(rows.every((r) => r.valueShare === 0 && r.cumulativeValueShare === 0)).toBe(true);
  });

  it('keeps a SKU that consumed nothing in the list rather than dropping it', () => {
    // The length of the C tail is the most useful thing the report says, and
    // silently excluding the dormant SKUs is what would understate it.
    const rows = classifyAbc(inputs([
      ['MOVER', 100, 100],
      ['DORMANT', 100, 0],
    ]), YEAR);

    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ sku: 'DORMANT', band: 'C', annualConsumptionValueCents: 0 });
  });

  it('breaks ties on SKU so two runs over the same data agree', () => {
    const rows = classifyAbc(inputs([
      ['ZZ', 10, 10],
      ['AA', 10, 10],
      ['MM', 10, 10],
    ]), YEAR);

    expect(rows.map((r) => r.sku)).toEqual(['AA', 'MM', 'ZZ']);
  });

  it('classifies an empty catalogue as an empty list', () => {
    expect(classifyAbc([], YEAR)).toEqual([]);
  });
});

describe('summariseAbc', () => {
  it('always reports three bands, including the empty ones', () => {
    const rows = classifyAbc(inputs([['ONLY', 100, 10]]), YEAR);
    const bands = summariseAbc(rows);

    expect(bands.map((b) => b.band)).toEqual(['A', 'B', 'C']);
    expect(bands.map((b) => b.itemCount)).toEqual([1, 0, 0]);
  });

  it('states the Pareto line: few items, most of the value', () => {
    // One SKU at 3600 against nine at 100 each: a tenth of the catalogue
    // carrying exactly 80% of the spend.
    const rows = classifyAbc(inputs([
      ['BIG', 1, 3600],
      ...Array.from({ length: 9 }, (_, i) => [`SMALL-${i}`, 1, 100] as [string, number, number]),
    ]), YEAR);
    const [a] = summariseAbc(rows);

    expect(rows).toHaveLength(10);
    expect(a?.itemCount).toBe(1);
    expect(a?.itemShare).toBeCloseTo(0.1, 6);
    expect(a?.valueShare).toBeCloseTo(0.8, 6);
  });

  it('sums to the catalogue total', () => {
    const rows = classifyAbc(inputs([
      ['A-1', 10, 100],
      ['B-1', 10, 15],
      ['C-1', 10, 5],
    ]), YEAR);
    const bands = summariseAbc(rows);

    expect(bands.reduce((sum, b) => sum + b.itemCount, 0)).toBe(3);
    expect(bands.reduce((sum, b) => sum + b.annualConsumptionValueCents, 0)).toBe(1200);
    expect(bands.reduce((sum, b) => sum + b.valueShare, 0)).toBeCloseTo(1, 6);
  });

  it('divides by nothing on an empty catalogue', () => {
    const bands = summariseAbc([]);

    expect(bands).toHaveLength(3);
    expect(bands.every((b) => b.itemShare === 0 && b.valueShare === 0)).toBe(true);
  });
});
