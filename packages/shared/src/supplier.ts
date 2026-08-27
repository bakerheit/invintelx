import { z } from 'zod';
import { DEFAULT_LEAD_TIME_DAYS } from './analytics.js';
import {
  isoDateSchema,
  objectIdSchema,
  paginatedSchema,
  paginationQuerySchema,
  sortOrderSchema,
} from './common.js';
import { itemSchema } from './item.js';

export const SUPPLIER_STATUSES = ['active', 'archived'] as const;
export const supplierStatusSchema = z.enum(SUPPLIER_STATUSES);
export type SupplierStatus = z.infer<typeof supplierStatusSchema>;

/**
 * Payment terms as a closed set rather than free text.
 *
 * "Net 30" written eleven different ways is eleven different terms as far as
 * any later report is concerned, and cash-flow forecasting needs to do
 * arithmetic on this. `other` is the escape hatch for the genuinely unusual
 * arrangement; whatever it is goes in the supplier's notes.
 */
export const PAYMENT_TERMS = [
  'prepaid',
  'cod',
  'net_7',
  'net_14',
  'net_15',
  'net_30',
  'net_45',
  'net_60',
  'net_90',
  'other',
] as const;
export const paymentTermsSchema = z.enum(PAYMENT_TERMS);
export type PaymentTerms = z.infer<typeof paymentTermsSchema>;

/**
 * Days from invoice to payment due. Null for `other`, which is the whole reason
 * `other` is not simply "0": a term nobody has quantified must not silently
 * claim to be due immediately.
 */
export const PAYMENT_TERM_DAYS: Record<PaymentTerms, number | null> = {
  prepaid: 0,
  cod: 0,
  net_7: 7,
  net_14: 14,
  net_15: 15,
  net_30: 30,
  net_45: 45,
  net_60: 60,
  net_90: 90,
  other: null,
};

export function paymentDueDays(terms: PaymentTerms): number | null {
  return PAYMENT_TERM_DAYS[terms];
}

/** Same shape and the same reasoning as a SKU: uppercased so case cannot fork a supplier. */
export const supplierCodeSchema = z
  .string()
  .trim()
  .min(1, 'Code is required')
  .max(64, 'Code must be at most 64 characters')
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'Use letters, numbers, dot, dash or underscore')
  .transform((v) => v.toUpperCase());

/**
 * The supplier's own part number, kept exactly as they write it.
 *
 * Deliberately *not* uppercased the way our SKUs are. This string is copied
 * onto a purchase order and read back by their system, so it belongs to them
 * and changing its case is changing their data. Uniqueness within a supplier is
 * still case-insensitive - that is enforced by the index, not by rewriting the
 * value.
 */
export const supplierSkuSchema = z
  .string()
  .trim()
  .min(1, 'Supplier SKU is required')
  .max(64, 'Supplier SKU must be at most 64 characters');

/** ISO 4217. Price breaks are numbers; without this they are numbers of nothing. */
export const currencySchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{3}$/, 'Use a three-letter currency code, such as USD')
  .transform((v) => v.toUpperCase());

/**
 * What the supplier says they take, in days. Stored on its own and never
 * overwritten by observation: the analytics epic exists to show the gap between
 * this number and the one measured from receipts, and a field that gets
 * corrected towards reality can no longer show a gap.
 */
export const promisedLeadTimeDaysSchema = z
  .number()
  .int('Lead time must be a whole number of days')
  .min(0, 'Lead time cannot be negative')
  .max(365, 'Lead time must be at most 365 days');

const moneyCentsSchema = z
  .number()
  .int('Amount must be a whole number of cents')
  .min(0, 'Amount cannot be negative')
  .max(1_000_000_000_00, 'Amount is implausibly large');

/** Blank or a real address - "not recorded" is a legitimate state for a contact field. */
const optionalEmailSchema = z
  .string()
  .trim()
  .max(254)
  .refine((v) => v === '' || z.string().email().safeParse(v).success, 'Enter a valid email address')
  .transform((v) => v.toLowerCase())
  .default('');

const optionalWebsiteSchema = z
  .string()
  .trim()
  .max(500)
  .refine(
    (v) => v === '' || /^https?:\/\/\S+$/i.test(v),
    'Enter a URL starting with http:// or https://',
  )
  .default('');

export const supplierContactSchema = z.object({
  name: z.string(),
  email: z.string(),
  phone: z.string(),
  website: z.string(),
  address: z.string(),
});
export type SupplierContact = z.infer<typeof supplierContactSchema>;

export const supplierContactInputSchema = z.object({
  name: z.string().trim().max(120).default(''),
  email: optionalEmailSchema,
  phone: z.string().trim().max(50).default(''),
  website: optionalWebsiteSchema,
  /** One block of text. Nobody here is going to validate a postcode in 30 countries. */
  address: z.string().trim().max(500).default(''),
});

export const supplierSchema = z.object({
  id: objectIdSchema,
  code: z.string(),
  name: z.string(),
  status: supplierStatusSchema,
  contact: supplierContactSchema,
  paymentTerms: paymentTermsSchema,
  currency: z.string(),
  promisedLeadTimeDays: z.number().int(),
  notes: z.string(),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
});
export type Supplier = z.infer<typeof supplierSchema>;

export const createSupplierInputSchema = z.object({
  code: supplierCodeSchema,
  name: z.string().trim().min(1, 'Name is required').max(200),
  contact: supplierContactInputSchema.default({}),
  paymentTerms: paymentTermsSchema.default('net_30'),
  currency: currencySchema.default('USD'),
  /*
   * The same figure the analytics layer assumes when it has no supplier to ask,
   * so a supplier created without one behaves exactly as the system did before
   * it existed - rather than quietly becoming a zero-day supplier.
   */
  promisedLeadTimeDays: promisedLeadTimeDaysSchema.default(DEFAULT_LEAD_TIME_DAYS),
  notes: z.string().trim().max(2000).default(''),
});
export type CreateSupplierInput = z.infer<typeof createSupplierInputSchema>;

/**
 * Every field optional, and `contact` optional field by field.
 *
 * If `contact` were merely `.partial()` at the top level, sending one changed
 * phone number would rewrite the whole block and take the email address with
 * it. Status changes go through archive/restore, as with items.
 */
export const updateSupplierInputSchema = createSupplierInputSchema
  .omit({ contact: true })
  .partial()
  .extend({ contact: supplierContactInputSchema.partial().optional() });
export type UpdateSupplierInput = z.infer<typeof updateSupplierInputSchema>;

export const SUPPLIER_SORT_FIELDS = ['code', 'name', 'promisedLeadTimeDays', 'updatedAt'] as const;
export const supplierSortFieldSchema = z.enum(SUPPLIER_SORT_FIELDS);
export type SupplierSortField = z.infer<typeof supplierSortFieldSchema>;

export const listSuppliersQuerySchema = paginationQuerySchema.extend({
  q: z.string().trim().max(200).optional(),
  status: supplierStatusSchema.optional(),
  paymentTerms: paymentTermsSchema.optional(),
  sort: supplierSortFieldSchema.default('name'),
  order: sortOrderSchema.default('asc'),
});
export type ListSuppliersQuery = z.infer<typeof listSuppliersQuerySchema>;

export const supplierListResponseSchema = paginatedSchema(supplierSchema);
export type SupplierListResponse = z.infer<typeof supplierListResponseSchema>;

/** One rung of a quantity ladder: buy at least this many, pay this much each. */
export const priceBreakSchema = z.object({
  minQuantity: z
    .number()
    .int('Minimum quantity must be a whole number')
    .min(1, 'Minimum quantity must be at least 1')
    .max(1_000_000_000),
  unitPriceCents: moneyCentsSchema,
});
export type PriceBreak = z.infer<typeof priceBreakSchema>;

export const MAX_PRICE_BREAKS = 20;

/**
 * Sorted on the way in, so storage is canonical and no reader has to wonder.
 *
 * Two rungs starting at the same quantity is rejected rather than resolved:
 * there is no defensible answer to "which price applies at 100" when the data
 * says both, and picking one silently is how a purchase order goes out at the
 * wrong number.
 *
 * A ladder that gets *more* expensive with volume is allowed. It is unusual,
 * but surcharge pricing exists and refusing it would be us telling a supplier
 * their price list is wrong.
 */
export const priceBreaksSchema = z
  .array(priceBreakSchema)
  .max(MAX_PRICE_BREAKS, `At most ${MAX_PRICE_BREAKS} price breaks`)
  .superRefine((breaks, ctx) => {
    const seen = new Set<number>();
    breaks.forEach((brk, index) => {
      if (seen.has(brk.minQuantity)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, 'minQuantity'],
          message: `Two price breaks both start at ${brk.minQuantity}`,
        });
      }
      seen.add(brk.minQuantity);
    });
  })
  .transform((breaks) => [...breaks].sort((a, b) => a.minQuantity - b.minQuantity));

/**
 * What this supplier charges each for `quantity`, or null when the quantity is
 * below their lowest rung - which is a real answer, not a missing one. A
 * supplier who only quotes from 12 up has not priced 5, and inventing a price
 * for it would be worse than saying so.
 */
export function priceForQuantity(
  breaks: readonly PriceBreak[],
  quantity: number,
): number | null {
  let best: PriceBreak | null = null;
  for (const brk of breaks) {
    if (brk.minQuantity > quantity) continue;
    if (!best || brk.minQuantity > best.minQuantity) best = brk;
  }
  return best ? best.unitPriceCents : null;
}

/**
 * One item, as this supplier sells it.
 *
 * A separate record rather than an array inside the supplier: a distributor
 * supplies tens of thousands of SKUs, and an embedded array makes reading a
 * supplier's name cost the whole catalogue - and eventually exceeds the
 * document limit outright.
 */
export const supplierItemSchema = z.object({
  id: objectIdSchema,
  supplierId: objectIdSchema,
  itemId: objectIdSchema,
  supplierSku: z.string(),
  priceBreaks: z.array(priceBreakSchema),
  /**
   * Resolved at read time rather than copied in. The catalogue is current data,
   * not history, so a renamed item has to read as renamed here too. Null only
   * if the item has gone, which archiving does not do.
   */
  item: itemSchema.nullable(),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
});
export type SupplierItem = z.infer<typeof supplierItemSchema>;

export const createSupplierItemInputSchema = z.object({
  itemId: objectIdSchema,
  supplierSku: supplierSkuSchema,
  priceBreaks: priceBreaksSchema.default([]),
});
export type CreateSupplierItemInput = z.infer<typeof createSupplierItemInputSchema>;

/** The item on the far end is the identity of the link, so it is not editable. */
export const updateSupplierItemInputSchema = z.object({
  supplierSku: supplierSkuSchema.optional(),
  priceBreaks: priceBreaksSchema.optional(),
});
export type UpdateSupplierItemInput = z.infer<typeof updateSupplierItemInputSchema>;

export const listSupplierItemsQuerySchema = paginationQuerySchema;
export type ListSupplierItemsQuery = z.infer<typeof listSupplierItemsQuerySchema>;

export const supplierItemListResponseSchema = paginatedSchema(supplierItemSchema);
export type SupplierItemListResponse = z.infer<typeof supplierItemListResponseSchema>;
