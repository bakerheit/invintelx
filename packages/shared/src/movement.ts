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
