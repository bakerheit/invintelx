import {
  DAYS_PER_YEAR,
  ABC_BANDS,
  type AbcBand,
  type AbcBandSummary,
  type AbcRow,
} from '@invintelx/shared';
import type { ItemDoc } from '../db.js';

/*
 * The classification, with no database behind it.
 *
 * Split from analytics.ts for the same reason demand.ts and dashboardRank.ts
 * are: that module imports db.js, which parses the environment at load and
 * exits the process when it is not configured. Everything here is a pure
 * function of rows already fetched, so it can be tested without a mongod.
 *
 * ItemDoc is imported as a type only; nothing here reaches the database.
 */

/** One SKU and what it consumed over the observed window. */
export interface AbcInput {
  item: ItemDoc;
  /** Units issued in the window. Magnitude, never the ledger's negative sign. */
  unitsIssued: number;
}

/**
 * A window's consumption, stated as a year of it.
 *
 * Annualising is what makes the number comparable across instances and across
 * window lengths: 90 days of issues on one SKU and 180 on another are not the
 * same measurement, and ranking them against each other unadjusted would put
 * whichever had the longer history on top. It does assume the window is
 * representative, which for a seasonal SKU it is not — the honest fix is a
 * longer window, and windowDays is a query parameter for exactly that reason.
 */
export function annualUnitsFrom(unitsIssued: number, windowDays: number): number {
  if (windowDays <= 0) return 0;
  return (unitsIssued * DAYS_PER_YEAR) / windowDays;
}

/**
 * Which band a SKU falls in, given how much of the catalogue's value the SKUs
 * ranked above it already account for.
 *
 * The test is on the cumulative share *before* this row, so a SKU extends the
 * band it starts in rather than the one it ends in. Measuring after would push
 * the single item that is 90% of spend into B and leave A empty — the top of
 * the ranking is A by construction, which is what anyone reading an ABC report
 * expects.
 *
 * Nothing consumed means C regardless of position. Without that, a catalogue
 * where nothing has moved has a total of zero, every cumulative share is zero,
 * and every SKU in it is graded A.
 *
 * The cuts are divided down to fractions rather than the share multiplied up to
 * a percentage. Both are the same arithmetic until a share lands exactly on a
 * cut, where scaling one side introduces a rounding error the other does not
 * have and the textbook 80/15/5 catalogue lands in the wrong bands.
 */
export function bandFor(
  annualConsumptionValueCents: number,
  cumulativeShareBefore: number,
  aPercent: number,
  bPercent: number,
): AbcBand {
  if (annualConsumptionValueCents <= 0) return 'C';
  if (cumulativeShareBefore < aPercent / 100) return 'A';
  if (cumulativeShareBefore < bPercent / 100) return 'B';
  return 'C';
}

/**
 * Rank a catalogue by annual consumption value and cut it into A, B and C.
 *
 * Returned in rank order, highest value first, ties broken by SKU so that two
 * runs over unchanged data print the same list in the same order.
 */
export function classifyAbc(
  inputs: AbcInput[],
  options: { windowDays: number; aPercent: number; bPercent: number },
): AbcRow[] {
  const valued = inputs.map(({ item, unitsIssued }) => {
    const annualUnits = annualUnitsFrom(unitsIssued, options.windowDays);
    return {
      itemId: item._id.toHexString(),
      sku: item.sku,
      name: item.name,
      unitOfMeasure: item.unitOfMeasure,
      unitCostCents: item.unitCostCents,
      unitsIssued,
      annualUnits,
      // Cents are the unit of account here, so the fractional part of an
      // annualised year of them is rounded away rather than carried.
      annualConsumptionValueCents: Math.round(annualUnits * item.unitCostCents),
    };
  });

  valued.sort(
    (a, b) =>
      b.annualConsumptionValueCents - a.annualConsumptionValueCents ||
      a.sku.localeCompare(b.sku),
  );

  const total = valued.reduce((sum, row) => sum + row.annualConsumptionValueCents, 0);

  let cumulative = 0;
  return valued.map((row, index) => {
    const shareBefore = total > 0 ? cumulative / total : 0;
    cumulative += row.annualConsumptionValueCents;
    return {
      ...row,
      rank: index + 1,
      band: bandFor(row.annualConsumptionValueCents, shareBefore, options.aPercent, options.bPercent),
      valueShare: total > 0 ? row.annualConsumptionValueCents / total : 0,
      cumulativeValueShare: total > 0 ? cumulative / total : 0,
    };
  });
}

/**
 * The three bands in aggregate.
 *
 * Always three entries even when a band is empty: a report that silently drops
 * B reads as though B were something other than zero SKUs, and a UI rendering
 * three columns should not have to invent the missing one.
 */
export function summariseAbc(rows: AbcRow[]): AbcBandSummary[] {
  const total = rows.reduce((sum, row) => sum + row.annualConsumptionValueCents, 0);

  return ABC_BANDS.map((band) => {
    const inBand = rows.filter((row) => row.band === band);
    const value = inBand.reduce((sum, row) => sum + row.annualConsumptionValueCents, 0);
    return {
      band,
      itemCount: inBand.length,
      itemShare: rows.length > 0 ? inBand.length / rows.length : 0,
      annualConsumptionValueCents: value,
      valueShare: total > 0 ? value / total : 0,
    };
  });
}
