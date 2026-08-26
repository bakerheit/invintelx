import type { ObjectId } from 'mongodb';
import {
  DEFAULT_DEMAND_WINDOW_DAYS,
  type DemandPoint,
  type ReorderSuggestion,
  type ServiceLevel,
} from '@invintelx/shared';
import { items, movements, stockLevels } from '../db.js';
import { statsFromSeries, suggestReorder, windowStart } from './demand.js';

// Re-exported so callers have one import site for the analytics surface.
export { statsFromSeries, suggestReorder } from './demand.js';

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
