import { z } from 'zod';
import { isoDateSchema, objectIdSchema, paginatedSchema, paginationQuerySchema } from './common.js';

/**
 * A cycle count: what the book says, what somebody actually found, and the
 * difference between the two.
 *
 * Counting is where trust in the numbers is either earned or lost, so a sheet
 * records the whole act rather than only its outcome — the expected figure as it
 * stood when the sheet was cut, the counted figure with who entered it and when,
 * and the movement id that each accepted variance produced. A sheet that only
 * held the final adjustment would be indistinguishable from somebody typing a
 * number they liked.
 */

export const COUNT_SHEET_STATUSES = ['open', 'posted', 'cancelled'] as const;
export const countSheetStatusSchema = z.enum(COUNT_SHEET_STATUSES);
export type CountSheetStatus = z.infer<typeof countSheetStatusSchema>;

/**
 * How the lines were chosen. Kept on the sheet because "we counted the bin" and
 * "we counted these six SKUs in the bin" are different claims: only the first
 * one says anything about an item that turned up unlisted.
 */
export const COUNT_SHEET_SCOPES = ['location', 'items'] as const;
export const countSheetScopeSchema = z.enum(COUNT_SHEET_SCOPES);
export type CountSheetScope = z.infer<typeof countSheetScopeSchema>;

/**
 * The reason code every accepted variance is written under.
 *
 * A count variance is a miscount by definition — the book and the shelf
 * disagreed and the shelf won. Letting the counter pick from the whole reason
 * list would invite "damaged" on a line where nobody saw any damage, and the
 * shrinkage totals downstream would then be fiction.
 */
export const COUNT_ADJUSTMENT_REASON = 'miscount' as const;

/**
 * How big one sheet may get.
 *
 * The lines live inside the sheet document so that accepting a page of
 * variances is one atomic write. That is worth a ceiling: a bin with more than
 * a thousand distinct SKUs in it is a count that wants splitting anyway, and
 * nobody standing in an aisle reads a thousand-line report.
 */
export const MAX_COUNT_SHEET_LINES = 1000;

/** Counted quantity. Non-negative: you cannot find minus three of something. */
export const countedQuantitySchema = z
  .number()
  .int('Counted quantity must be a whole number')
  .min(0, 'Counted quantity cannot be negative')
  .max(1_000_000_000);

export const countSheetLineSchema = z.object({
  id: objectIdSchema,
  itemId: objectIdSchema,
  itemSku: z.string(),
  itemName: z.string(),
  /** On-hand at this bin when the sheet was cut, frozen from that moment on. */
  expectedQuantity: z.number().int(),
  /** Null until somebody counts it. Zero is a count; null is not. */
  countedQuantity: z.number().int().nullable(),
  /** counted − expected, or null while uncounted. Never inferred from zero. */
  variance: z.number().int().nullable(),
  countedAt: isoDateSchema.nullable(),
  countedByName: z.string(),
  /** The adjustment this line's variance produced, once accepted. */
  postedMovementId: objectIdSchema.nullable(),
  /** The signed quantity actually written. Null when nothing was written. */
  postedQuantity: z.number().int().nullable(),
});
export type CountSheetLine = z.infer<typeof countSheetLineSchema>;

/**
 * The numbers the variance report leads with.
 *
 * Derived rather than stored, so a sheet cannot carry a total that disagrees
 * with its own lines. Computed once here and used by both ends, so the figure
 * on the screen is the figure the server would print.
 */
export const countSheetSummarySchema = z.object({
  lineCount: z.number().int(),
  countedCount: z.number().int(),
  uncountedCount: z.number().int(),
  /** Counted and in agreement — the boring lines, which should be most of them. */
  agreedCount: z.number().int(),
  varianceCount: z.number().int(),
  /** More on the shelf than on the books. */
  overCount: z.number().int(),
  /** Less on the shelf than on the books. This is the column people care about. */
  shortCount: z.number().int(),
  /** Sum of the variances, signed. Nets a +5 against a −5. */
  netVariance: z.number().int(),
  /**
   * Sum of the absolute variances.
   *
   * The honest measure of how wrong the records were: a bin that is five over
   * on one SKU and five short on another has a net of zero and ten units of
   * error, and reporting that as "no variance" is how counting stops meaning
   * anything.
   */
  absVariance: z.number().int(),
  /**
   * Lines that agreed, over lines counted. Null when nothing has been counted
   * yet — an empty count is not a perfect one, and 0/0 must never read as 100%.
   */
  accuracy: z.number().nullable(),
});
export type CountSheetSummary = z.infer<typeof countSheetSummarySchema>;

export const countSheetSchema = z.object({
  id: objectIdSchema,
  /** Short, sayable, and what somebody writes at the top of a paper sheet. */
  reference: z.string(),
  locationId: objectIdSchema,
  locationCode: z.string(),
  locationPathLabel: z.string(),
  scope: countSheetScopeSchema,
  status: countSheetStatusSchema,
  note: z.string(),
  summary: countSheetSummarySchema,
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
  createdByName: z.string(),
  postedAt: isoDateSchema.nullable(),
  postedByName: z.string(),
  cancelledAt: isoDateSchema.nullable(),
});
export type CountSheet = z.infer<typeof countSheetSchema>;

/** The sheet with its lines. What the aisle report is rendered from. */
export const countSheetDetailSchema = countSheetSchema.extend({
  lines: z.array(countSheetLineSchema),
});
export type CountSheetDetail = z.infer<typeof countSheetDetailSchema>;

export const createCountSheetInputSchema = z.object({
  locationId: objectIdSchema,
  /**
   * Empty means "everything the books say is in this bin". Naming items instead
   * narrows the sheet to those, whether or not the books think any are there —
   * counting a SKU the records show as zero is exactly how a lost pallet is
   * found.
   */
  itemIds: z.array(objectIdSchema).max(MAX_COUNT_SHEET_LINES).default([]),
  note: z.string().trim().max(500).default(''),
});
export type CreateCountSheetInput = z.infer<typeof createCountSheetInputSchema>;

/** Null clears a count back to uncounted, which is not the same as counting zero. */
export const recordCountInputSchema = z.object({
  countedQuantity: countedQuantitySchema.nullable(),
});
export type RecordCountInput = z.infer<typeof recordCountInputSchema>;

/**
 * Accepting variances is one deliberate act on named lines.
 *
 * There is no "post everything" flag on purpose. A sheet is closed by somebody
 * saying which differences they believe, and a default that accepted the lot
 * would make that signature worthless.
 */
export const postCountSheetInputSchema = z.object({
  lineIds: z.array(objectIdSchema).min(1, 'Pick the lines to accept').max(MAX_COUNT_SHEET_LINES),
  note: z.string().trim().max(500).default(''),
});
export type PostCountSheetInput = z.infer<typeof postCountSheetInputSchema>;

export const cancelCountSheetInputSchema = z.object({
  note: z.string().trim().max(500).default(''),
});
export type CancelCountSheetInput = z.infer<typeof cancelCountSheetInputSchema>;

export const listCountSheetsQuerySchema = paginationQuerySchema.extend({
  status: countSheetStatusSchema.optional(),
  locationId: objectIdSchema.optional(),
});
export type ListCountSheetsQuery = z.infer<typeof listCountSheetsQuerySchema>;

export const countSheetListResponseSchema = paginatedSchema(countSheetSchema);
export type CountSheetListResponse = z.infer<typeof countSheetListResponseSchema>;

/** What a line is worth, or null while nobody has counted it. */
export function lineVariance(line: {
  expectedQuantity: number;
  countedQuantity: number | null;
}): number | null {
  if (line.countedQuantity === null) return null;
  return line.countedQuantity - line.expectedQuantity;
}

export function summariseCountSheet(
  lines: readonly { expectedQuantity: number; countedQuantity: number | null }[],
): CountSheetSummary {
  let countedCount = 0;
  let agreedCount = 0;
  let overCount = 0;
  let shortCount = 0;
  let netVariance = 0;
  let absVariance = 0;

  for (const line of lines) {
    const variance = lineVariance(line);
    if (variance === null) continue;

    countedCount += 1;
    netVariance += variance;
    absVariance += Math.abs(variance);
    if (variance === 0) agreedCount += 1;
    else if (variance > 0) overCount += 1;
    else shortCount += 1;
  }

  return {
    lineCount: lines.length,
    countedCount,
    uncountedCount: lines.length - countedCount,
    agreedCount,
    varianceCount: countedCount - agreedCount,
    overCount,
    shortCount,
    netVariance,
    absVariance,
    accuracy: countedCount === 0 ? null : agreedCount / countedCount,
  };
}

/**
 * The one sentence the report leads with, said the way somebody in an aisle
 * would say it. Kept next to the arithmetic so the words and the numbers cannot
 * drift apart.
 */
export function varianceHeadline(summary: CountSheetSummary): string {
  if (summary.countedCount === 0) return 'Nothing counted yet';
  if (summary.varianceCount === 0) {
    return `All ${summary.countedCount.toLocaleString()} counted ${summary.countedCount === 1 ? 'line agrees' : 'lines agree'}`;
  }

  const parts: string[] = [];
  if (summary.shortCount > 0) parts.push(`${summary.shortCount.toLocaleString()} short`);
  if (summary.overCount > 0) parts.push(`${summary.overCount.toLocaleString()} over`);
  return `${parts.join(', ')} · ${summary.absVariance.toLocaleString()} units out`;
}

/** "3 short" / "2 over" / "agrees" — one line's answer, in two words. */
export function varianceLabel(variance: number | null): string {
  if (variance === null) return 'Not counted';
  if (variance === 0) return 'Agrees';
  const magnitude = Math.abs(variance).toLocaleString();
  return variance > 0 ? `${magnitude} over` : `${magnitude} short`;
}
