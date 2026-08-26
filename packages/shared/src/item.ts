import { z } from 'zod';
import {
  isoDateSchema,
  objectIdSchema,
  paginatedSchema,
  paginationQuerySchema,
  sortOrderSchema,
} from './common.js';

export const UNITS_OF_MEASURE = [
  'each',
  'case',
  'pallet',
  'kg',
  'g',
  'lb',
  'oz',
  'l',
  'ml',
  'm',
  'ft',
] as const;
export const unitOfMeasureSchema = z.enum(UNITS_OF_MEASURE);
export type UnitOfMeasure = z.infer<typeof unitOfMeasureSchema>;

export const ITEM_STATUSES = ['active', 'archived'] as const;
export const itemStatusSchema = z.enum(ITEM_STATUSES);
export type ItemStatus = z.infer<typeof itemStatusSchema>;

/**
 * SKUs are uppercased on the way in. Warehouse staff type them in whatever case
 * they like, and "ABC-1" and "abc-1" being two different items is a bug that is
 * very expensive to discover six months later.
 */
export const skuSchema = z
  .string()
  // Trim first. Checks run in the order they are declared, so validating before
  // trimming would reject a pasted SKU with a trailing space and tell the user
  // it contains illegal characters, which is both wrong and baffling.
  .trim()
  .min(1, 'SKU is required')
  .max(64, 'SKU must be at most 64 characters')
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'Use letters, numbers, dot, dash or underscore')
  .transform((v) => v.toUpperCase());

const moneyCentsSchema = z
  .number()
  .int('Amount must be a whole number of cents')
  .min(0, 'Amount cannot be negative')
  .max(1_000_000_000_00, 'Amount is implausibly large');

const quantitySchema = z.number().int().min(0, 'Quantity cannot be negative').max(1_000_000_000);

export const itemSchema = z.object({
  id: objectIdSchema,
  sku: z.string(),
  name: z.string(),
  description: z.string(),
  category: z.string(),
  unitOfMeasure: unitOfMeasureSchema,
  barcode: z.string(),
  unitCostCents: z.number().int(),
  unitPriceCents: z.number().int(),
  reorderPoint: z.number().int(),
  reorderQuantity: z.number().int(),
  status: itemStatusSchema,
  /** Escape hatch for the fields every business swears are unique to them. */
  attributes: z.record(z.string(), z.string()),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
});
export type Item = z.infer<typeof itemSchema>;

export const createItemInputSchema = z.object({
  sku: skuSchema,
  name: z.string().min(1, 'Name is required').max(200).trim(),
  description: z.string().max(2000).trim().default(''),
  category: z.string().max(100).trim().default(''),
  unitOfMeasure: unitOfMeasureSchema.default('each'),
  barcode: z.string().max(64).trim().default(''),
  unitCostCents: moneyCentsSchema.default(0),
  unitPriceCents: moneyCentsSchema.default(0),
  reorderPoint: quantitySchema.default(0),
  reorderQuantity: quantitySchema.default(0),
  attributes: z.record(z.string(), z.string()).default({}),
});
export type CreateItemInput = z.infer<typeof createItemInputSchema>;

/** Every field optional; status changes go through the archive endpoint instead. */
export const updateItemInputSchema = createItemInputSchema.partial();
export type UpdateItemInput = z.infer<typeof updateItemInputSchema>;

export const ITEM_SORT_FIELDS = [
  'sku',
  'name',
  'category',
  'unitCostCents',
  'unitPriceCents',
  'reorderPoint',
  'updatedAt',
] as const;
export const itemSortFieldSchema = z.enum(ITEM_SORT_FIELDS);
export type ItemSortField = z.infer<typeof itemSortFieldSchema>;

export const listItemsQuerySchema = paginationQuerySchema.extend({
  q: z.string().trim().max(200).optional(),
  category: z.string().trim().max(100).optional(),
  status: itemStatusSchema.optional(),
  sort: itemSortFieldSchema.default('updatedAt'),
  order: sortOrderSchema.default('desc'),
});
export type ListItemsQuery = z.infer<typeof listItemsQuerySchema>;

export const itemListResponseSchema = paginatedSchema(itemSchema);
export type ItemListResponse = z.infer<typeof itemListResponseSchema>;
