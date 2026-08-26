import { z } from 'zod';
import { isoDateSchema, objectIdSchema } from './common.js';

/**
 * How far back demand is measured. Long enough to survive a quiet fortnight,
 * short enough that last quarter's behaviour does not dominate this month's.
 */
export const DEFAULT_DEMAND_WINDOW_DAYS = 90;

/**
 * Assumed supplier lead time, until suppliers exist and carry their own.
 * Deliberately a named constant rather than a literal buried in the maths, so
 * that when INVX-25 lands there is one place to replace.
 */
export const DEFAULT_LEAD_TIME_DAYS = 14;

/**
 * Service level is the probability of not stocking out during lead time. The
 * z-score is how many standard deviations of demand variability to hold as
 * safety stock to achieve it.
 */
export const SERVICE_LEVELS = ['90', '95', '99'] as const;
export const serviceLevelSchema = z.enum(SERVICE_LEVELS);
export type ServiceLevel = z.infer<typeof serviceLevelSchema>;

export const SERVICE_LEVEL_Z: Record<ServiceLevel, number> = {
  '90': 1.2816,
  '95': 1.6449,
  '99': 2.3263,
};

export const demandPointSchema = z.object({
  /** YYYY-MM-DD, in UTC. */
  date: z.string(),
  quantity: z.number().int().min(0),
});
export type DemandPoint = z.infer<typeof demandPointSchema>;

export const demandStatsSchema = z.object({
  itemId: objectIdSchema,
  windowDays: z.number().int(),
  /** Total units issued across the window. */
  totalIssued: z.number().int(),
  /** Days in the window on which anything was issued at all. */
  daysWithDemand: z.number().int(),
  /**
   * Averaged over every day in the window, not only the days with demand.
   * Days of cover asks "how long will this last", and the quiet days count.
   */
  averageDailyDemand: z.number(),
  /** Standard deviation of daily demand, the input to safety stock. */
  demandStdDev: z.number(),
  series: z.array(demandPointSchema),
});
export type DemandStats = z.infer<typeof demandStatsSchema>;

/**
 * A suggestion with its arithmetic attached. Nobody changes a reorder point
 * because a black box told them to, so every input is carried alongside the
 * answer and the UI shows the working.
 */
export const reorderSuggestionSchema = z.object({
  itemId: objectIdSchema,
  sku: z.string(),
  name: z.string(),
  unitOfMeasure: z.string(),
  onHand: z.number().int(),
  currentReorderPoint: z.number().int(),
  currentReorderQuantity: z.number().int(),

  averageDailyDemand: z.number(),
  demandStdDev: z.number(),
  leadTimeDays: z.number().int(),
  serviceLevel: serviceLevelSchema,

  /** avgDailyDemand x leadTimeDays */
  demandDuringLeadTime: z.number(),
  /** z x stdDev x sqrt(leadTimeDays) */
  safetyStock: z.number(),
  /** demandDuringLeadTime + safetyStock, rounded up */
  suggestedReorderPoint: z.number().int(),
  suggestedOrderQuantity: z.number().int(),

  /** onHand / avgDailyDemand. Null when nothing has been issued at all. */
  daysOfCover: z.number().nullable(),
  belowReorderPoint: z.boolean(),
  /** onHand x unit cost, in cents — the capital currently tied up here. */
  valueOnHandCents: z.number().int(),
  /**
   * averageDailyDemand x unit cost, in cents: the value of a day's demand.
   *
   * This is what ranks a stockout, not the value on hand — which is zero
   * precisely when the SKU is most urgent, and so degenerates as a tiebreak at
   * the exact moment it is needed.
   */
  dailyDemandValueCents: z.number().int(),
});
export type ReorderSuggestion = z.infer<typeof reorderSuggestionSchema>;

export const actionListQuerySchema = z.object({
  windowDays: z.coerce.number().int().min(7).max(730).default(DEFAULT_DEMAND_WINDOW_DAYS),
  leadTimeDays: z.coerce.number().int().min(0).max(365).default(DEFAULT_LEAD_TIME_DAYS),
  serviceLevel: serviceLevelSchema.default('95'),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type ActionListQuery = z.infer<typeof actionListQuerySchema>;

export const actionListResponseSchema = z.object({
  generatedAt: isoDateSchema,
  windowDays: z.number().int(),
  leadTimeDays: z.number().int(),
  serviceLevel: serviceLevelSchema,
  /** How many SKUs were considered, so a short list is not mistaken for no data. */
  itemsConsidered: z.number().int(),
  items: z.array(reorderSuggestionSchema),
});
export type ActionListResponse = z.infer<typeof actionListResponseSchema>;

/** What GET /analytics/demand/:itemId returns: the series and what it implies. */
export const itemDemandResponseSchema = z.object({
  stats: demandStatsSchema,
  suggestion: reorderSuggestionSchema,
});
export type ItemDemandResponse = z.infer<typeof itemDemandResponseSchema>;
