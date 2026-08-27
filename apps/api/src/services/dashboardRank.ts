import type { DeadStockRow, ReorderSuggestion } from '@invintelx/shared';
import type { ItemDoc } from '../db.js';

/*
 * Which SKUs make the dashboard, and in what order — with no database behind it.
 *
 * Split from analytics.ts for the same reason demand.ts is: that module imports
 * db.js, which parses the environment at load and exits the process when it is
 * not configured. Everything here is a pure function of rows already fetched,
 * so it can be tested without a mongod.
 *
 * ItemDoc is imported as a type only; nothing here reaches the database.
 */

const MS_PER_DAY = 86_400_000;

/**
 * Ranked by days of cover ascending, because that is the honest measure of how
 * soon this hurts. Ties break on the value of demand going unmet per day, which
 * stays meaningful at zero stock — unlike the value sitting on the shelf, which
 * is zero precisely when a SKU is most urgent. An item with no demand at all
 * sorts last rather than first: it is not urgent, it is merely low.
 */
export function byUrgency(a: ReorderSuggestion, b: ReorderSuggestion): number {
  const aCover = a.daysOfCover ?? Number.POSITIVE_INFINITY;
  const bCover = b.daysOfCover ?? Number.POSITIVE_INFINITY;
  if (aCover !== bCover) return aCover - bCover;
  return b.dailyDemandValueCents - a.dailyDemandValueCents;
}

/**
 * Out of stock everywhere. Negative counts as out — a projection that has gone
 * below zero is a SKU nobody can pick from, whatever the arithmetic says.
 */
export function isStockout(suggestion: ReorderSuggestion): boolean {
  return suggestion.onHand <= 0;
}

/**
 * The SKUs that are already out, costliest first.
 *
 * Days of cover cannot rank these: it is zero for every one of them. What
 * separates a stockout that matters from one that does not is how much demand
 * is walking away each day it stays out.
 */
export function rankStockouts(suggestions: ReorderSuggestion[]): ReorderSuggestion[] {
  return suggestions
    .filter(isStockout)
    .sort(
      (a, b) => b.dailyDemandValueCents - a.dailyDemandValueCents || a.sku.localeCompare(b.sku),
    );
}

/**
 * At or below the reorder point but not yet out.
 *
 * Stockouts are excluded on purpose. They are a worse problem with a different
 * remedy, and listing them in both places would make the dashboard's two most
 * urgent rows the same SKU twice.
 */
export function rankBelowReorderPoint(suggestions: ReorderSuggestion[]): ReorderSuggestion[] {
  return suggestions.filter((s) => s.belowReorderPoint && !isStockout(s)).sort(byUrgency);
}

/** Whole days between two instants, floored. */
function daysBetween(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / MS_PER_DAY));
}

/**
 * Staleness measured from the last issue, or from when the item was created if
 * there has never been one.
 *
 * Measuring "never issued" as infinitely stale would put every SKU added this
 * morning at the top of the dead stock list on its first day, which is the
 * fastest way to teach somebody to ignore the list.
 */
export function toDeadStockRow(
  item: ItemDoc,
  onHand: number,
  lastIssuedAt: Date | null,
  now: Date,
): DeadStockRow {
  return {
    itemId: item._id.toHexString(),
    sku: item.sku,
    name: item.name,
    unitOfMeasure: item.unitOfMeasure,
    onHand,
    valueOnHandCents: onHand * item.unitCostCents,
    daysStale: daysBetween(lastIssuedAt ?? item.createdAt, now),
    neverIssued: lastIssuedAt === null,
    lastIssuedAt: lastIssuedAt?.toISOString() ?? null,
  };
}

/**
 * Dead stock worth money, most capital first.
 *
 * Three filters, all load-bearing. Stock on hand, because a SKU with an empty
 * shelf is not dead, it is finished. Value above zero, because the question is
 * which stock is money nobody is turning over — a SKU with no cost recorded is
 * a data gap, and ranking it by a value of zero puts it where it belongs rather
 * than at the top of a list sorted by value. And staleness, which is the whole
 * definition.
 */
export function rankDeadStock(rows: DeadStockRow[], deadStockDays: number): DeadStockRow[] {
  return rows
    .filter((r) => r.onHand > 0 && r.valueOnHandCents > 0 && r.daysStale >= deadStockDays)
    .sort((a, b) => b.valueOnHandCents - a.valueOnHandCents || a.sku.localeCompare(b.sku));
}
