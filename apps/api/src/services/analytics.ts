import type { ObjectId } from 'mongodb';
import {
  DEFAULT_DEMAND_WINDOW_DAYS,
  SERVICE_LEVEL_Z,
  type DemandPoint,
  type DemandStats,
  type ReorderSuggestion,
  type ServiceLevel,
} from '@invintelx/shared';
import { items, movements, stockLevels, type ItemDoc } from '../db.js';

/** UTC day key. Local days would shift the whole series when the clocks change. */
function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function windowStart(windowDays: number, now: Date): Date {
  const start = new Date(now);
  start.setUTCDate(start.getUTCDate() - (windowDays - 1));
  start.setUTCHours(0, 0, 0, 0);
  return start;
}

/**
 * Daily demand per item over a window.
 *
 * Demand means issues and only issues. A transfer relocates stock and an
 * adjustment corrects a record; treating either as consumption would inflate
 * every forecast downstream.
 */
export async function demandByItem(
  itemIds: ObjectId[],
  windowDays: number,
  now = new Date(),
): Promise<Map<string, DemandPoint[]>> {
  if (itemIds.length === 0) return new Map();
  const start = windowStart(windowDays, now);

  const rows = await movements()
    .aggregate<{ _id: { itemId: ObjectId; day: string }; quantity: number }>([
      { $match: { itemId: { $in: itemIds }, type: 'issue', occurredAt: { $gte: start } } },
      {
        $group: {
          _id: {
            itemId: '$itemId',
            day: { $dateToString: { format: '%Y-%m-%d', date: '$occurredAt', timezone: 'UTC' } },
          },
          // Issues are stored negative; demand is the magnitude consumed.
          quantity: { $sum: { $abs: '$quantity' } },
        },
      },
    ])
    .toArray();

  const byItem = new Map<string, DemandPoint[]>();
  for (const row of rows) {
    const key = row._id.itemId.toHexString();
    const list = byItem.get(key) ?? [];
    list.push({ date: row._id.day, quantity: row.quantity });
    byItem.set(key, list);
  }
  for (const list of byItem.values()) list.sort((a, b) => a.date.localeCompare(b.date));
  return byItem;
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

/**
 * The SKUs worth acting on today, worst first.
 *
 * Ranked by days of cover ascending, because that is the honest measure of how
 * soon this hurts. Ties break on consumption value, so when two SKUs run out on
 * the same day the expensive one is dealt with first. An item at or below its
 * reorder point with no demand at all sorts last rather than first — it is not
 * urgent, it is merely low.
 */
export async function buildActionList(options: {
  windowDays?: number;
  leadTimeDays: number;
  serviceLevel: ServiceLevel;
  limit: number;
  now?: Date;
}): Promise<{ suggestions: ReorderSuggestion[]; itemsConsidered: number }> {
  const windowDays = options.windowDays ?? DEFAULT_DEMAND_WINDOW_DAYS;
  const now = options.now ?? new Date();

  const activeItems = await items().find({ status: 'active' }).toArray();
  if (activeItems.length === 0) return { suggestions: [], itemsConsidered: 0 };

  const itemIds = activeItems.map((i) => i._id);
  const [demand, levels] = await Promise.all([
    demandByItem(itemIds, windowDays, now),
    stockLevels()
      .aggregate<{ _id: ObjectId; onHand: number }>([
        { $match: { itemId: { $in: itemIds } } },
        { $group: { _id: '$itemId', onHand: { $sum: '$onHand' } } },
      ])
      .toArray(),
  ]);

  const onHandByItem = new Map(levels.map((row) => [row._id.toHexString(), row.onHand]));

  const suggestions = activeItems.map((item) => {
    const key = item._id.toHexString();
    const stats = statsFromSeries(key, demand.get(key) ?? [], windowDays, now);
    return suggestReorder(item, stats, onHandByItem.get(key) ?? 0, options.leadTimeDays, options.serviceLevel);
  });

  const needsAction = suggestions.filter((s) => s.belowReorderPoint);
  needsAction.sort((a, b) => {
    const aCover = a.daysOfCover ?? Number.POSITIVE_INFINITY;
    const bCover = b.daysOfCover ?? Number.POSITIVE_INFINITY;
    if (aCover !== bCover) return aCover - bCover;
    // Ties are common at zero cover, where several SKUs are equally out. Break
    // on the value of demand going unmet per day, which stays meaningful at
    // zero stock — unlike the value sitting on the shelf, which does not.
    return b.dailyDemandValueCents - a.dailyDemandValueCents;
  });

  return { suggestions: needsAction.slice(0, options.limit), itemsConsidered: activeItems.length };
}
