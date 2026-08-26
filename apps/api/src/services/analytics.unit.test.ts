import { describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import { SERVICE_LEVEL_Z } from '@invintelx/shared';
// From the pure module deliberately: importing analytics.js would pull in
// db.js and its env parsing, which is what broke CI.
import { statsFromSeries, suggestReorder } from './demand.js';
import type { ItemDoc } from '../db.js';

/** Fixed clock. A window relative to "now" is untestable without one. */
const NOW = new Date('2026-03-10T12:00:00.000Z');

function item(overrides: Partial<ItemDoc> = {}): ItemDoc {
  return {
    _id: new ObjectId(),
    sku: 'TEST-1',
    name: 'Test item',
    description: '',
    category: '',
    unitOfMeasure: 'each',
    barcode: '',
    unitCostCents: 250,
    unitPriceCents: 500,
    reorderPoint: 20,
    reorderQuantity: 100,
    status: 'active',
    attributes: {},
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('statsFromSeries', () => {
  it('averages over every day in the window, not only the days with demand', () => {
    // 100 units on one day of ten. Averaging over the two days that had demand
    // would say 50/day; the honest answer for "how long will stock last" is 10.
    const stats = statsFromSeries('x', [{ date: '2026-03-05', quantity: 100 }], 10, NOW);

    expect(stats.totalIssued).toBe(100);
    expect(stats.daysWithDemand).toBe(1);
    expect(stats.averageDailyDemand).toBe(10);
    // Nine days at 0 and one at 100: variance 9000/10, so sigma is 30.
    expect(stats.demandStdDev).toBeCloseTo(30, 6);
  });

  it('reports zero demand rather than dividing by nothing', () => {
    const stats = statsFromSeries('x', [], 30, NOW);
    expect(stats.totalIssued).toBe(0);
    expect(stats.averageDailyDemand).toBe(0);
    expect(stats.demandStdDev).toBe(0);
  });

  it('gives steady demand a standard deviation of zero', () => {
    // Days 6..10 of March, which is exactly the five-day window ending at NOW.
    const series = Array.from({ length: 5 }, (_, i) => ({
      date: `2026-03-${String(6 + i).padStart(2, '0')}`,
      quantity: 7,
    }));
    const stats = statsFromSeries('x', series, 5, NOW);
    expect(stats.averageDailyDemand).toBe(7);
    expect(stats.demandStdDev).toBeCloseTo(0, 10);
  });

  it('ignores demand that falls outside the window', () => {
    const stats = statsFromSeries(
      'x',
      [
        { date: '2026-01-01', quantity: 999 }, // long before the window opens
        { date: '2026-03-09', quantity: 5 },
      ],
      7,
      NOW,
    );
    expect(stats.totalIssued).toBe(5);
  });
});

describe('suggestReorder', () => {
  const stats = statsFromSeries('x', [{ date: '2026-03-05', quantity: 100 }], 10, NOW);

  it('is demand during lead time plus safety stock', () => {
    const suggestion = suggestReorder(item(), stats, 50, 4, '95');

    expect(suggestion.demandDuringLeadTime).toBeCloseTo(40, 6);
    // z x sigma x sqrt(leadTime) = 1.6449 x 30 x 2
    expect(suggestion.safetyStock).toBeCloseTo(SERVICE_LEVEL_Z['95'] * 30 * 2, 6);
    expect(suggestion.suggestedReorderPoint).toBe(139);
  });

  it('scales safety stock with the square root of lead time, not with lead time', () => {
    // Variance accumulates linearly over independent days, so sigma grows with
    // the root. Quadrupling lead time should double safety stock, not quadruple.
    const short = suggestReorder(item(), stats, 50, 4, '95');
    const long = suggestReorder(item(), stats, 50, 16, '95');
    expect(long.safetyStock / short.safetyStock).toBeCloseTo(2, 6);
  });

  it('holds more stock for a higher service level', () => {
    const ninety = suggestReorder(item(), stats, 50, 7, '90');
    const ninetyNine = suggestReorder(item(), stats, 50, 7, '99');
    expect(ninetyNine.safetyStock).toBeGreaterThan(ninety.safetyStock);
  });

  it('computes days of cover from average daily demand', () => {
    const suggestion = suggestReorder(item(), stats, 50, 4, '95');
    expect(suggestion.daysOfCover).toBeCloseTo(5, 6);
  });

  it('reports days of cover as null when nothing has ever been issued', () => {
    // Not Infinity and not zero: with no demand the question has no answer, and
    // any number here would be read as one.
    const idle = statsFromSeries('x', [], 30, NOW);
    expect(suggestReorder(item(), idle, 500, 7, '95').daysOfCover).toBeNull();
  });

  it('never suggests ordering less than the item already asks for', () => {
    const suggestion = suggestReorder(item({ reorderQuantity: 500 }), stats, 10_000, 4, '95');
    expect(suggestion.suggestedOrderQuantity).toBe(500);
  });

  it('flags an item at or below its configured reorder point', () => {
    expect(suggestReorder(item({ reorderPoint: 20 }), stats, 20, 4, '95').belowReorderPoint).toBe(true);
    expect(suggestReorder(item({ reorderPoint: 20 }), stats, 21, 4, '95').belowReorderPoint).toBe(false);
  });

  it('values what is on hand at cost, in cents', () => {
    const suggestion = suggestReorder(item({ unitCostCents: 250 }), stats, 40, 4, '95');
    expect(suggestion.valueOnHandCents).toBe(10_000);
  });

  it('keeps a value signal that survives a stockout', () => {
    // Value on hand is zero exactly when a SKU is most urgent, so it cannot be
    // what ranks one stockout above another. Demand value still can.
    const suggestion = suggestReorder(item({ unitCostCents: 250 }), stats, 0, 4, '95');
    expect(suggestion.valueOnHandCents).toBe(0);
    expect(suggestion.dailyDemandValueCents).toBe(2500);
  });

  it('carries every input so the UI can show the working', () => {
    const suggestion = suggestReorder(item(), stats, 50, 4, '95');
    expect(suggestion).toMatchObject({
      averageDailyDemand: 10,
      leadTimeDays: 4,
      serviceLevel: '95',
      onHand: 50,
      currentReorderPoint: 20,
    });
    expect(suggestion.demandStdDev).toBeCloseTo(30, 6);
  });
});
