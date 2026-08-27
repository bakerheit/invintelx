import { describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import type { ReorderSuggestion } from '@invintelx/shared';
// From the pure module deliberately: importing analytics.js would pull in
// db.js and its env parsing, which is what broke CI once already.
import { statsFromSeries, suggestReorder } from './demand.js';
import {
  isStockout,
  rankBelowReorderPoint,
  rankDeadStock,
  rankStockouts,
  toDeadStockRow,
} from './dashboardRank.js';
import type { ItemDoc } from '../db.js';

/** Fixed clock. Staleness relative to "now" is untestable without one. */
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
    createdAt: new Date('2025-01-01T00:00:00.000Z'),
    updatedAt: NOW,
    ...overrides,
  };
}

/**
 * A suggestion built the way the real one is, so the ranking is exercised
 * against arithmetic rather than against hand-written numbers that could drift
 * from what suggestReorder actually produces.
 */
function suggestion(options: {
  sku: string;
  onHand: number;
  dailyDemand: number;
  reorderPoint?: number;
  unitCostCents?: number;
}): ReorderSuggestion {
  // One day of the ten-day window carries ten days' worth, so the average over
  // the window is exactly `dailyDemand`.
  const stats = statsFromSeries(
    'x',
    options.dailyDemand > 0 ? [{ date: '2026-03-05', quantity: options.dailyDemand * 10 }] : [],
    10,
    NOW,
  );
  return suggestReorder(
    item({
      sku: options.sku,
      reorderPoint: options.reorderPoint ?? 20,
      unitCostCents: options.unitCostCents ?? 250,
    }),
    stats,
    options.onHand,
    4,
    '95',
  );
}

describe('isStockout', () => {
  it('counts an empty shelf as out', () => {
    expect(isStockout(suggestion({ sku: 'A', onHand: 0, dailyDemand: 1 }))).toBe(true);
  });

  it('counts a negative projection as out', () => {
    // A projection below zero is a data problem, but it is still a SKU nobody
    // can pick from. Treating it as "in stock" would hide the worst case.
    expect(isStockout(suggestion({ sku: 'A', onHand: -5, dailyDemand: 1 }))).toBe(true);
  });

  it('does not count a low but non-empty shelf as out', () => {
    expect(isStockout(suggestion({ sku: 'A', onHand: 1, dailyDemand: 1 }))).toBe(false);
  });
});

describe('rankStockouts', () => {
  it('ranks by the value of demand going unmet, not by days of cover', () => {
    // Days of cover is zero for every stockout, so it cannot separate them.
    const cheap = suggestion({ sku: 'CHEAP', onHand: 0, dailyDemand: 10, unitCostCents: 10 });
    const dear = suggestion({ sku: 'DEAR', onHand: 0, dailyDemand: 2, unitCostCents: 5000 });

    expect(rankStockouts([cheap, dear]).map((s) => s.sku)).toEqual(['DEAR', 'CHEAP']);
  });

  it('breaks a genuine tie on SKU so the order is stable', () => {
    const a = suggestion({ sku: 'B-1', onHand: 0, dailyDemand: 3 });
    const b = suggestion({ sku: 'A-1', onHand: 0, dailyDemand: 3 });

    expect(rankStockouts([a, b]).map((s) => s.sku)).toEqual(['A-1', 'B-1']);
  });

  it('leaves out anything still holding stock', () => {
    const low = suggestion({ sku: 'LOW', onHand: 5, dailyDemand: 1, reorderPoint: 20 });
    expect(rankStockouts([low])).toEqual([]);
  });
});

describe('rankBelowReorderPoint', () => {
  it('ranks by days of cover, soonest to run out first', () => {
    const soon = suggestion({ sku: 'SOON', onHand: 4, dailyDemand: 4, reorderPoint: 20 });
    const later = suggestion({ sku: 'LATER', onHand: 16, dailyDemand: 4, reorderPoint: 20 });

    expect(rankBelowReorderPoint([later, soon]).map((s) => s.sku)).toEqual(['SOON', 'LATER']);
  });

  it('excludes stockouts, which belong to their own list', () => {
    // Otherwise the two most urgent rows on the dashboard are the same SKU
    // twice, and the second list is a worse copy of the first.
    const out = suggestion({ sku: 'OUT', onHand: 0, dailyDemand: 4, reorderPoint: 20 });
    const low = suggestion({ sku: 'LOW', onHand: 4, dailyDemand: 4, reorderPoint: 20 });

    expect(rankBelowReorderPoint([out, low]).map((s) => s.sku)).toEqual(['LOW']);
  });

  it('sorts an item with no demand last rather than first', () => {
    // No demand means null cover. Sorted as a number it would lead the list;
    // it is not urgent, it is merely low.
    const idle = suggestion({ sku: 'IDLE', onHand: 5, dailyDemand: 0, reorderPoint: 20 });
    const busy = suggestion({ sku: 'BUSY', onHand: 8, dailyDemand: 4, reorderPoint: 20 });

    expect(rankBelowReorderPoint([idle, busy]).map((s) => s.sku)).toEqual(['BUSY', 'IDLE']);
  });

  it('leaves out anything above its reorder point', () => {
    const healthy = suggestion({ sku: 'OK', onHand: 500, dailyDemand: 1, reorderPoint: 20 });
    expect(rankBelowReorderPoint([healthy])).toEqual([]);
  });
});

describe('toDeadStockRow', () => {
  it('measures staleness from the last issue', () => {
    const row = toDeadStockRow(item(), 40, new Date('2026-01-09T12:00:00.000Z'), NOW);

    expect(row.daysStale).toBe(60);
    expect(row.neverIssued).toBe(false);
    expect(row.lastIssuedAt).toBe('2026-01-09T12:00:00.000Z');
  });

  it('measures a never-issued item from when it was created', () => {
    // Not from the beginning of time: a SKU added this morning has not gone
    // dead, and putting it at the top of the list teaches people to ignore it.
    const fresh = item({ createdAt: new Date('2026-03-08T12:00:00.000Z') });
    const row = toDeadStockRow(fresh, 40, null, NOW);

    expect(row.daysStale).toBe(2);
    expect(row.neverIssued).toBe(true);
    expect(row.lastIssuedAt).toBeNull();
  });

  it('values what is on hand at cost, in cents', () => {
    expect(toDeadStockRow(item({ unitCostCents: 250 }), 40, null, NOW).valueOnHandCents).toBe(
      10_000,
    );
  });

  it('never reports negative staleness for a movement dated in the future', () => {
    // Backdating is supported, so forward-dating is possible too.
    const row = toDeadStockRow(item(), 40, new Date('2026-04-01T00:00:00.000Z'), NOW);
    expect(row.daysStale).toBe(0);
  });
});

describe('rankDeadStock', () => {
  const stale = (sku: string, onHand: number, unitCostCents: number, days: number) =>
    toDeadStockRow(
      item({ sku, unitCostCents }),
      onHand,
      new Date(NOW.getTime() - days * 86_400_000),
      NOW,
    );

  it('ranks by capital tied up, most first', () => {
    const rows = [stale('SMALL', 10, 100, 200), stale('BIG', 10, 5000, 200)];
    expect(rankDeadStock(rows, 90).map((r) => r.sku)).toEqual(['BIG', 'SMALL']);
  });

  it('excludes anything issued inside the window', () => {
    expect(rankDeadStock([stale('RECENT', 10, 5000, 30)], 90)).toEqual([]);
  });

  it('includes an item exactly at the threshold', () => {
    expect(rankDeadStock([stale('EDGE', 10, 5000, 90)], 90).map((r) => r.sku)).toEqual(['EDGE']);
  });

  it('excludes a SKU with an empty shelf', () => {
    // Nothing on hand is not dead stock, it is a finished SKU. There is no
    // money to release and nothing to act on.
    expect(rankDeadStock([stale('GONE', 0, 5000, 200)], 90)).toEqual([]);
  });

  it('excludes a SKU with no cost recorded', () => {
    // The list is dead stock *worth money*. A SKU with no unit cost is a data
    // gap, and it would sort at the bottom of a value ranking anyway — leaving
    // it out says so honestly rather than padding the list.
    expect(rankDeadStock([stale('NOCOST', 999, 0, 200)], 90)).toEqual([]);
  });

  it('breaks a tie on SKU so the order is stable', () => {
    const rows = [stale('B-1', 10, 1000, 200), stale('A-1', 10, 1000, 200)];
    expect(rankDeadStock(rows, 90).map((r) => r.sku)).toEqual(['A-1', 'B-1']);
  });
});
