import type { ObjectId } from 'mongodb';
import {
  DEFAULT_DEMAND_WINDOW_DAYS,
  type AbcBand,
  type AbcResponse,
  type AbcRow,
  type DashboardResponse,
  type DeadStockResponse,
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
import { classifyAbc, summariseAbc } from './abc.js';

// Re-exported so callers have one import site for the analytics surface.
export { statsFromSeries, suggestReorder } from './demand.js';

/**
 * What counts as consumption in a window, in one place.
 *
 * Demand means issues and only issues. A transfer relocates stock and an
 * adjustment corrects a record; treating either as consumption would inflate
 * every forecast downstream.
 *
 * The daily series and the ABC totals group this differently but must never
 * disagree about which rows they are grouping, so the filter is written once.
 */
function issuedInWindow(
  itemIds: ObjectId[],
  windowDays: number,
  now: Date,
): Record<string, unknown> {
  return {
    itemId: { $in: itemIds },
    type: 'issue',
    occurredAt: { $gte: windowStart(windowDays, now) },
  };
}

/** Daily demand per item over a window. */
export async function demandByItem(
  itemIds: ObjectId[],
  windowDays: number,
  now = new Date(),
): Promise<Map<string, DemandPoint[]>> {
  if (itemIds.length === 0) return new Map();

  const rows = await movements()
    .aggregate<{ _id: { itemId: ObjectId; day: string }; quantity: number }>([
      { $match: issuedInWindow(itemIds, windowDays, now) },
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
 * Total units issued per item over a window — the same rows `demandByItem`
 * reads, grouped only by item.
 *
 * Summing the daily series would give the same answer, but a catalogue-wide
 * ABC report would then carry one row per item per day back from the database
 * to add it up here. This asks Mongo for the total it is already computing.
 */
export async function issuedUnitsByItem(
  itemIds: ObjectId[],
  windowDays: number,
  now = new Date(),
): Promise<Map<string, number>> {
  if (itemIds.length === 0) return new Map();

  const rows = await movements()
    .aggregate<{ _id: ObjectId; quantity: number }>([
      { $match: issuedInWindow(itemIds, windowDays, now) },
      // Issues are stored negative; consumption is the magnitude consumed.
      { $group: { _id: '$itemId', quantity: { $sum: { $abs: '$quantity' } } } },
    ])
    .toArray();

  return new Map(rows.map((row) => [row._id.toHexString(), row.quantity]));
}

/**
 * On-hand per item, summed across every location it sits in.
 *
 * Every report here asks the catalogue-wide question rather than the per-bin
 * one, so the sum is written once: four copies of this pipeline is four places
 * for "how much have we got" to drift apart.
 */
export async function onHandByItem(itemIds: ObjectId[]): Promise<Map<string, number>> {
  if (itemIds.length === 0) return new Map();

  const rows = await stockLevels()
    .aggregate<{ _id: ObjectId; onHand: number }>([
      { $match: { itemId: { $in: itemIds } } },
      { $group: { _id: '$itemId', onHand: { $sum: '$onHand' } } },
    ])
    .toArray();

  return new Map(rows.map((row) => [row._id.toHexString(), row.onHand]));
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
  const [demand, onHand] = await Promise.all([
    demandByItem(itemIds, windowDays, now),
    onHandByItem(itemIds),
  ]);

  const suggestions = activeItems.map((item) => {
    const key = item._id.toHexString();
    const stats = statsFromSeries(key, demand.get(key) ?? [], windowDays, now);
    return suggestReorder(item, stats, onHand.get(key) ?? 0, options.leadTimeDays, options.serviceLevel);
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

  const [demand, onHandTotals, lastIssued, volumeSeries] = await Promise.all([
    demandByItem(itemIds, options.windowDays, now),
    onHandByItem(itemIds),
    lastIssuedByItem(itemIds),
    // Independent of the catalogue: the ledger is still worth showing when
    // every item has been archived.
    movementVolume(options.windowDays, now),
  ]);

  const suggestions: ReorderSuggestion[] = [];
  const deadStockRows = [];
  for (const item of activeItems) {
    const key = item._id.toHexString();
    const onHand = onHandTotals.get(key) ?? 0;
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

/** The dead stock report, minus the timestamp the route stamps on. */
export type DeadStockSnapshot = Omit<DeadStockResponse, 'generatedAt'>;

/**
 * Every SKU holding stock nobody has issued in a while, most capital first.
 *
 * The same rows the dashboard shortlists, at report length and with the window
 * as a parameter rather than a default. The dashboard asks "is there a dead
 * stock problem"; this is the list somebody works through to fix it, so the
 * limit is high and `total` and `valueCents` are stated across the whole set
 * rather than the page — the capital tied up is the headline, and a headline
 * that changed when somebody paged would be a lie.
 *
 * Archived items are excluded, exactly as they are on the dashboard. Stock
 * stranded on an archived SKU is a real problem and a different one: writing
 * off a SKU nobody can transact against is not the same job as turning over one
 * that is still live.
 */
export async function buildDeadStockReport(options: {
  deadStockDays: number;
  limit: number;
  now?: Date;
}): Promise<DeadStockSnapshot> {
  const now = options.now ?? new Date();
  const activeItems = await items().find({ status: 'active' }).toArray();
  const itemIds = activeItems.map((i) => i._id);

  const [onHand, lastIssued] = await Promise.all([
    onHandByItem(itemIds),
    lastIssuedByItem(itemIds),
  ]);

  const rows = activeItems.map((item) => {
    const key = item._id.toHexString();
    return toDeadStockRow(item, onHand.get(key) ?? 0, lastIssued.get(key) ?? null, now);
  });

  // The same filter and comparator the dashboard uses, so the two screens
  // cannot disagree about which SKUs are dead or in what order.
  const dead = rankDeadStock(rows, options.deadStockDays);

  return {
    deadStockDays: options.deadStockDays,
    itemsConsidered: activeItems.length,
    total: dead.length,
    valueCents: dead.reduce((sum, row) => sum + row.valueOnHandCents, 0),
    rows: dead.slice(0, options.limit),
  };
}

/** The ABC report, minus the timestamp the route stamps on. */
export type AbcSnapshot = Omit<AbcResponse, 'generatedAt'>;

/**
 * The active catalogue ranked by annual consumption value and cut into bands.
 *
 * Every active SKU is classified, including the ones that consumed nothing —
 * they are the C tail, and a classification that quietly dropped them would
 * understate how long that tail is, which is the single most useful thing an
 * ABC report says. The band filter narrows what is returned, never what is
 * counted: `bands` and `itemsConsidered` are always the whole catalogue.
 */
export async function buildAbcReport(options: {
  windowDays: number;
  aPercent: number;
  bPercent: number;
  band?: AbcBand;
  limit: number;
  now?: Date;
}): Promise<AbcSnapshot> {
  const now = options.now ?? new Date();
  const activeItems = await items().find({ status: 'active' }).toArray();
  const itemIds = activeItems.map((i) => i._id);

  const issued = await issuedUnitsByItem(itemIds, options.windowDays, now);

  const classified: AbcRow[] = classifyAbc(
    activeItems.map((item) => ({
      item,
      unitsIssued: issued.get(item._id.toHexString()) ?? 0,
    })),
    options,
  );

  const selected = options.band
    ? classified.filter((row) => row.band === options.band)
    : classified;

  return {
    windowDays: options.windowDays,
    aPercent: options.aPercent,
    bPercent: options.bPercent,
    itemsConsidered: classified.length,
    annualConsumptionValueCents: classified.reduce(
      (sum, row) => sum + row.annualConsumptionValueCents,
      0,
    ),
    bands: summariseAbc(classified),
    total: selected.length,
    rows: selected.slice(0, options.limit),
  };
}
