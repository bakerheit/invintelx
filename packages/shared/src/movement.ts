import { z } from 'zod';
import { isoDateSchema, objectIdSchema, paginatedSchema, paginationQuerySchema } from './common.js';

/**
 * The stock ledger is append-only. A movement is never updated or deleted; a
 * mistake is corrected by posting a compensating movement, which is how a real
 * stock ledger works and the only way the history stays true.
 */
export const MOVEMENT_TYPES = ['receipt', 'issue', 'transfer', 'adjustment', 'count'] as const;
export const movementTypeSchema = z.enum(MOVEMENT_TYPES);
export type MovementType = z.infer<typeof movementTypeSchema>;

/**
 * Which movements represent the business consuming a unit.
 *
 * Only these feed the demand series. A transfer moves stock between locations
 * and an adjustment corrects a record; neither means anything was used, so
 * counting them as demand would inflate every forecast.
 */
export const DEMAND_MOVEMENT_TYPES: readonly MovementType[] = ['issue'];

export const movementQuantitySchema = z
  .number()
  .int('Quantity must be a whole number')
  .refine((v) => v !== 0, 'Quantity cannot be zero');

/** Positive quantity for the movement screens, which carry direction separately. */
export const positiveQuantitySchema = z
  .number()
  .int('Quantity must be a whole number')
  .positive('Quantity must be greater than zero')
  .max(1_000_000_000);

/**
 * Why stock was adjusted. A closed list, not free text.
 *
 * Free-text reasons are how shrinkage becomes untraceable: nobody can total
 * "damaged" across a year when it is spelled six ways.
 */
export const ADJUSTMENT_REASONS = [
  'damaged',
  'lost',
  'found',
  'miscount',
  'expired',
  'other',
] as const;
export const adjustmentReasonSchema = z.enum(ADJUSTMENT_REASONS);
export type AdjustmentReason = z.infer<typeof adjustmentReasonSchema>;

/**
 * A transfer is a pair, and reversing one leg of it invents or destroys stock.
 *
 * Learned from a peer review of a parallel implementation, where reversing the
 * out-leg of a 5-unit transfer left -5 +5 +5 on the books: five units nobody
 * ever received. The remedy for a wrong transfer is the opposite transfer,
 * which is written as a pair in one transaction.
 */
export const REVERSIBLE_MOVEMENT_TYPES: readonly MovementType[] = [
  'receipt',
  'issue',
  'adjustment',
];

export function isReversible(type: MovementType): boolean {
  return REVERSIBLE_MOVEMENT_TYPES.includes(type);
}

export const TRANSFER_REVERSAL_MESSAGE =
  'A transfer moves stock as a pair, so reversing one leg alone would invent or destroy stock. Post the opposite transfer instead.';

export const movementSchema = z.object({
  id: objectIdSchema,
  itemId: objectIdSchema,
  itemSku: z.string(),
  itemName: z.string(),
  locationId: objectIdSchema,
  locationCode: z.string(),
  /** Signed: positive adds to the location, negative removes. */
  quantity: z.number().int(),
  type: movementTypeSchema,
  /** Free-form pointer at whatever caused this — a PO line, a count sheet. */
  reference: z.string(),
  note: z.string(),
  /** Both legs of a transfer carry the same group, so the pair can be found. */
  groupId: objectIdSchema.nullable(),
  /** Set when this row exists to compensate an earlier one. */
  reversesId: objectIdSchema.nullable(),
  /**
   * Set when this row was posted against a purchase order line.
   *
   * `reference` above can carry the order number for a person to read, but a
   * string is not something you can join on. These two are: they are what makes
   * "which receipts satisfied this line" and "how long did this supplier
   * actually take" queries rather than transcription.
   */
  purchaseOrderId: objectIdSchema.nullable(),
  purchaseOrderLineId: objectIdSchema.nullable(),
  /** Only meaningful on an adjustment. */
  reason: adjustmentReasonSchema.nullable(),
  occurredAt: isoDateSchema,
  actorId: objectIdSchema,
  actorName: z.string(),
  createdAt: isoDateSchema,
});
export type Movement = z.infer<typeof movementSchema>;

export const receiveInputSchema = z.object({
  itemId: objectIdSchema,
  locationId: objectIdSchema,
  quantity: positiveQuantitySchema,
  reference: z.string().trim().max(120).default(''),
  note: z.string().trim().max(500).default(''),
  /** Backdating is legitimate — paperwork arrives late. */
  occurredAt: isoDateSchema.optional(),
});
export type ReceiveInput = z.infer<typeof receiveInputSchema>;

export const issueInputSchema = receiveInputSchema;
export type IssueInput = z.infer<typeof issueInputSchema>;

export const transferInputSchema = z
  .object({
    itemId: objectIdSchema,
    fromLocationId: objectIdSchema,
    toLocationId: objectIdSchema,
    quantity: positiveQuantitySchema,
    reference: z.string().trim().max(120).default(''),
    note: z.string().trim().max(500).default(''),
    occurredAt: isoDateSchema.optional(),
  })
  // A transfer to the same bin is a no-op that still writes two rows and two
  // projection updates, so it is rejected rather than quietly recorded.
  .refine((v) => v.fromLocationId !== v.toLocationId, {
    message: 'Pick two different bins',
    path: ['toLocationId'],
  });
export type TransferInput = z.infer<typeof transferInputSchema>;

export const adjustInputSchema = z.object({
  itemId: objectIdSchema,
  locationId: objectIdSchema,
  /** Signed: negative writes stock off, positive writes it on. */
  quantity: movementQuantitySchema,
  reason: adjustmentReasonSchema,
  note: z.string().trim().max(500).default(''),
  occurredAt: isoDateSchema.optional(),
});
export type AdjustInput = z.infer<typeof adjustInputSchema>;

export const reverseInputSchema = z.object({
  note: z.string().trim().max(500).default(''),
});
export type ReverseInput = z.infer<typeof reverseInputSchema>;

export const listMovementsQuerySchema = paginationQuerySchema.extend({
  itemId: objectIdSchema.optional(),
  locationId: objectIdSchema.optional(),
  type: movementTypeSchema.optional(),
});
export type ListMovementsQuery = z.infer<typeof listMovementsQuerySchema>;

export const movementListResponseSchema = paginatedSchema(movementSchema);
export type MovementListResponse = z.infer<typeof movementListResponseSchema>;

/** On-hand, projected from the ledger. Never written to directly. */
export const stockLevelSchema = z.object({
  itemId: objectIdSchema,
  locationId: objectIdSchema,
  locationCode: z.string(),
  onHand: z.number().int(),
  updatedAt: isoDateSchema,
});
export type StockLevel = z.infer<typeof stockLevelSchema>;

export const itemStockSchema = z.object({
  itemId: objectIdSchema,
  totalOnHand: z.number().int(),
  byLocation: z.array(stockLevelSchema),
});
export type ItemStock = z.infer<typeof itemStockSchema>;

/** A movement plus the balance at that location immediately after it. */
export const movementWithBalanceSchema = movementSchema.extend({
  balanceAfter: z.number().int(),
});
export type MovementWithBalance = z.infer<typeof movementWithBalanceSchema>;

export const movementHistoryResponseSchema = paginatedSchema(movementWithBalanceSchema);
export type MovementHistoryResponse = z.infer<typeof movementHistoryResponseSchema>;
