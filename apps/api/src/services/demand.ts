import type {
  DemandPoint,
  DemandStats,
  ReorderSuggestion,
  ServiceLevel,
} from '@invintelx/shared';
import { SERVICE_LEVEL_Z } from '@invintelx/shared';
import type { ItemDoc } from '../db.js';

/*
 * The maths, with no database behind it.
 *
 * Split out of analytics.ts because that module imports db.js, which parses the
 * environment at load and exits the process if it is not configured. That made
 * the pure functions impossible to import without a live .env — which passed
 * locally, where one exists, and killed CI, where one correctly does not.
 *
 * ItemDoc is imported as a type only, so nothing here reaches the database at
 * runtime.
 */

/** UTC day key. Local days would shift the whole series when the clocks change. */
function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function windowStart(windowDays: number, now: Date): Date {
  const start = new Date(now);
  start.setUTCDate(start.getUTCDate() - (windowDays - 1));
  start.setUTCHours(0, 0, 0, 0);
  return start;
}

/**
 * Turn a sparse series into statistics over the full window.
 *
 * The zero-demand days are included on purpose. Days of cover asks how long
 * stock will last, and averaging only over days that had demand would answer a
 * different, more flattering question.
 */
export function statsFromSeries(
  itemId: string,
  series: DemandPoint[],
  windowDays: number,
  now = new Date(),
): DemandStats {
  const byDay = new Map(series.map((p) => [p.date, p.quantity]));

  const dense: number[] = [];
  const cursor = windowStart(windowDays, now);
  for (let i = 0; i < windowDays; i += 1) {
    dense.push(byDay.get(dayKey(cursor)) ?? 0);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  const totalIssued = dense.reduce((sum, q) => sum + q, 0);
  const average = totalIssued / windowDays;
  const variance = dense.reduce((sum, q) => sum + (q - average) ** 2, 0) / windowDays;

  return {
    itemId,
    windowDays,
    totalIssued,
    daysWithDemand: dense.filter((q) => q > 0).length,
    averageDailyDemand: average,
    demandStdDev: Math.sqrt(variance),
    series,
  };
}

/**
 * Reorder point from demand during lead time plus safety stock.
 *
 *   demandDuringLeadTime = avgDailyDemand x leadTimeDays
 *   safetyStock          = z x stdDev x sqrt(leadTimeDays)
 *   reorderPoint         = ceil(demandDuringLeadTime + safetyStock)
 *
 * The sqrt is not decoration: variance accumulates linearly over independent
 * days, so the standard deviation of demand across a lead time grows with the
 * square root of its length, not with its length.
 */
export function suggestReorder(
  item: ItemDoc,
  stats: DemandStats,
  onHand: number,
  leadTimeDays: number,
  serviceLevel: ServiceLevel,
): ReorderSuggestion {
  const z = SERVICE_LEVEL_Z[serviceLevel];
  const demandDuringLeadTime = stats.averageDailyDemand * leadTimeDays;
  const safetyStock = z * stats.demandStdDev * Math.sqrt(leadTimeDays);
  const suggestedReorderPoint = Math.ceil(demandDuringLeadTime + safetyStock);

  // Order back up to the reorder point plus one more lead time of demand, but
  // never less than the quantity already configured for the item.
  const gap = Math.max(0, suggestedReorderPoint + demandDuringLeadTime - onHand);
  const suggestedOrderQuantity = Math.max(item.reorderQuantity, Math.ceil(gap));

  return {
    itemId: item._id.toHexString(),
    sku: item.sku,
    name: item.name,
    unitOfMeasure: item.unitOfMeasure,
    onHand,
    currentReorderPoint: item.reorderPoint,
    currentReorderQuantity: item.reorderQuantity,
    averageDailyDemand: stats.averageDailyDemand,
    demandStdDev: stats.demandStdDev,
    leadTimeDays,
    serviceLevel,
    demandDuringLeadTime,
    safetyStock,
    suggestedReorderPoint,
    suggestedOrderQuantity,
    /*
     * No demand at all means stock lasts indefinitely, which is not a number.
     *
     * A deficit is clamped to zero rather than reported as negative days: you
     * cannot have less than no cover, and "-19.5 days" ranked above a genuinely
     * urgent SKU while telling the reader nothing. The shortfall is visible in
     * onHand, which sits next to it.
     */
    daysOfCover:
      stats.averageDailyDemand > 0 ? Math.max(0, onHand) / stats.averageDailyDemand : null,
    belowReorderPoint: onHand <= item.reorderPoint,
    valueOnHandCents: onHand * item.unitCostCents,
    dailyDemandValueCents: Math.round(stats.averageDailyDemand * item.unitCostCents),
  };
}
