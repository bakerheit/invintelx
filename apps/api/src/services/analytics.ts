import type { ObjectId } from 'mongodb';
import {
  DEFAULT_DEMAND_WINDOW_DAYS,
  type DashboardResponse,
  type DemandPoint,
  type ReorderSuggestion,
  type ServiceLevel,
  type VolumePoint,
} from '@invintelx/shared';
import { items, movements, stockLevels } from '../db.js';
import { statsFromSeries, suggestReorder, windowStart } from './demand.js';
import {
  byUrgency,
  rankBelowReorderPoint,
  rankDeadStock,
  rankStockouts,
  toDeadStockRow,
} from './dashboardRank.js';

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

  // The comparator lives in dashboardRank.ts so the dashboard's below-reorder
  // shortlist and this list cannot drift into ranking the same thing differently.
  const needsAction = suggestions.filter((s) => s.belowReorderPoint).sort(byUrgency);

  return { suggestions: needsAction.slice(0, options.limit), itemsConsidered: activeItems.length };
}

/**
 * When each item was last issued. Not bounded by any window — "dead" is a
 * question about how long ago, so a cutoff would collapse "issued four months
 * back" and "never issued in five years" into the same answer.
 */
export async function lastIssuedByItem(itemIds: ObjectId[]): Promise<Map<string, Date>> {
  if (itemIds.length === 0) return new Map();

  const rows = await movements()
    .aggregate<{ _id: ObjectId; lastIssuedAt: Date }>([
      { $match: { itemId: { $in: itemIds }, type: 'issue' } },
      { $group: { _id: '$itemId', lastIssuedAt: { $max: '$occurredAt' } } },
    ])
    .toArray();

  return new Map(rows.map((row) => [row._id.toHexString(), row.lastIssuedAt]));
}

/**
 * Units that moved per day, across every kind of movement.
 *
 * Counted by magnitude, so writing stock off and booking it in both register as
 * work done — this measures how busy the warehouse is, not whether stock went
 * up. The one exception is a transfer, which writes two rows for a single
 * physical move: only the inbound leg counts, because summing both would report
 * twice the units that actually shifted.
 */
export async function movementVolume(windowDays: number, now = new Date()): Promise<VolumePoint[]> {
  const start = windowStart(windowDays, now);

  const rows = await movements()
    .aggregate<{ _id: string; quantity: number }>([
      {
        $match: {
          occurredAt: { $gte: start },
          $nor: [{ type: 'transfer', quantity: { $lt: 0 } }],
        },
      },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$occurredAt', timezone: 'UTC' } },
          quantity: { $sum: { $abs: '$quantity' } },
        },
      },
    ])
    .toArray();

  return rows
    .map((row) => ({ date: row._id, quantity: row.quantity }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** Everything the landing screen renders, minus the timestamp the route stamps on. */
export type DashboardSnapshot = Omit<DashboardResponse, 'generatedAt'>;

/**
 * The landing screen in one query round.
 *
 * Four questions — what is out, what is about to be, what has stopped moving,
 * and how big and how busy this business is — answered from one pass over the
 * active catalogue. Splitting them across endpoints would have the screen firing
 * four requests that each re-read the same items and could disagree about the
 * on-hand figure by however long they were apart.
 *
 * Archived items are excluded throughout, including from the inventory value.
 * Stock stranded on an archived SKU is a real problem, but it is not one this
 * screen can be honest about while every other number on it counts only the
 * live catalogue.
 */
export async function buildDashboard(options: {
  windowDays: number;
  leadTimeDays: number;
  serviceLevel: ServiceLevel;
  deadStockDays: number;
  limit: number;
  now?: Date;
}): Promise<DashboardSnapshot> {
  const now = options.now ?? new Date();
  const activeItems = await items().find({ status: 'active' }).toArray();
  const itemIds = activeItems.map((i) => i._id);

  const [demand, levels, lastIssued, volumeSeries] = await Promise.all([
    demandByItem(itemIds, options.windowDays, now),
    stockLevels()
      .aggregate<{ _id: ObjectId; onHand: number }>([
        { $match: { itemId: { $in: itemIds } } },
        { $group: { _id: '$itemId', onHand: { $sum: '$onHand' } } },
      ])
      .toArray(),
    lastIssuedByItem(itemIds),
    // Independent of the catalogue: the ledger is still worth showing when
    // every item has been archived.
    movementVolume(options.windowDays, now),
  ]);

  const onHandByItem = new Map(levels.map((row) => [row._id.toHexString(), row.onHand]));

  const suggestions: ReorderSuggestion[] = [];
  const deadStockRows = [];
  for (const item of activeItems) {
    const key = item._id.toHexString();
    const onHand = onHandByItem.get(key) ?? 0;
    const stats = statsFromSeries(key, demand.get(key) ?? [], options.windowDays, now);
    suggestions.push(
      suggestReorder(item, stats, onHand, options.leadTimeDays, options.serviceLevel),
    );
    deadStockRows.push(toDeadStockRow(item, onHand, lastIssued.get(key) ?? null, now));
  }

  const stockouts = rankStockouts(suggestions);
  const belowReorderPoint = rankBelowReorderPoint(suggestions);
  const deadStock = rankDeadStock(deadStockRows, options.deadStockDays);

  return {
    windowDays: options.windowDays,
    leadTimeDays: options.leadTimeDays,
    serviceLevel: options.serviceLevel,
    deadStockDays: options.deadStockDays,
    itemsConsidered: activeItems.length,

    stockouts: { total: stockouts.length, rows: stockouts.slice(0, options.limit) },
    belowReorderPoint: {
      total: belowReorderPoint.length,
      rows: belowReorderPoint.slice(0, options.limit),
    },
    deadStock: {
      total: deadStock.length,
      valueCents: deadStock.reduce((sum, row) => sum + row.valueOnHandCents, 0),
      rows: deadStock.slice(0, options.limit),
    },

    // Summed from the same suggestions the lists are ranked from, so the total
    // and the rows can never disagree about what is on the shelf.
    inventoryValueCents: suggestions.reduce((sum, s) => sum + s.valueOnHandCents, 0),
    movementVolume: {
      windowDays: options.windowDays,
      totalUnits: volumeSeries.reduce((sum, point) => sum + point.quantity, 0),
      series: volumeSeries,
    },
  };
}
