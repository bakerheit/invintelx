import { z } from 'zod';
import {
  isoDateSchema,
  objectIdSchema,
  paginatedSchema,
  paginationQuerySchema,
  sortOrderSchema,
} from './common.js';
import { movementSchema, positiveQuantitySchema } from './movement.js';

/**
 * A purchase order is a promise, and the ledger is a record of fact. The two are
 * separate on purpose: ordering a hundred units changes nothing about what is in
 * the building, and only a receipt moves stock. What a PO adds is the link
 * between the two — a receipt that knows which line it satisfied, so "what is
 * still owed to us" is arithmetic rather than memory.
 */
export const PURCHASE_ORDER_STATUSES = [
  'draft',
  'sent',
  'partial',
  'received',
  'cancelled',
] as const;
export const purchaseOrderStatusSchema = z.enum(PURCHASE_ORDER_STATUSES);
export type PurchaseOrderStatus = z.infer<typeof purchaseOrderStatusSchema>;

/**
 * Which status may become which, as a lookup rather than a chain of ifs.
 *
 * `sent -> partial -> received` is not walked by hand: those three are derived
 * from the lines every time a receipt lands, by `derivePurchaseOrderStatus`.
 * They appear here so that the table is the whole truth about what can follow
 * what, and so a reader can see that `received` and `cancelled` are terminal.
 */
export const PURCHASE_ORDER_TRANSITIONS: Record<
  PurchaseOrderStatus,
  readonly PurchaseOrderStatus[]
> = {
  draft: ['sent', 'cancelled'],
  sent: ['partial', 'received', 'cancelled'],
  partial: ['received', 'cancelled'],
  received: [],
  cancelled: [],
};

export function canTransition(from: PurchaseOrderStatus, to: PurchaseOrderStatus): boolean {
  return PURCHASE_ORDER_TRANSITIONS[from].includes(to);
}

/** Nothing more will happen to an order in one of these. */
export function isClosedPurchaseOrder(status: PurchaseOrderStatus): boolean {
  return PURCHASE_ORDER_TRANSITIONS[status].length === 0;
}

/**
 * Receiving is refused on a draft, deliberately.
 *
 * A draft has not been sent to anybody, so stock arriving against it means
 * either the order went out unrecorded or the delivery belongs to a different
 * order. Both are worth a person's attention, and neither is served by silently
 * accepting the goods against a document the supplier has never seen. Stock that
 * genuinely turned up unordered has its own door: `POST /movements/receive`.
 */
export function canReceive(status: PurchaseOrderStatus): boolean {
  return status === 'sent' || status === 'partial';
}

/** Only a draft can be sent, and only a draft can have its lines edited. */
export function canSend(status: PurchaseOrderStatus): boolean {
  return status === 'draft';
}

export function canEditLines(status: PurchaseOrderStatus): boolean {
  return status === 'draft';
}

/**
 * A partly-received order can still be cancelled: a supplier who cannot ship the
 * rest is the ordinary case, not an error. What was received stays on the ledger
 * — cancelling closes the order, it does not unreceive anything.
 */
export function canCancel(status: PurchaseOrderStatus): boolean {
  return canTransition(status, 'cancelled');
}

/** Purchase order numbers are sequential and zero-padded, so they sort as text. */
export function formatPurchaseOrderNumber(sequence: number): string {
  return `PO-${String(sequence).padStart(5, '0')}`;
}

const moneyCentsSchema = z
  .number()
  .int('Amount must be a whole number of cents')
  .min(0, 'Amount cannot be negative')
  .max(1_000_000_000_00, 'Amount is implausibly large');

const orderedQuantitySchema = z
  .number()
  .int('Quantity must be a whole number')
  .positive('Order at least one')
  .max(1_000_000_000);

/** The arithmetic below only needs these two numbers off a line. */
export interface ReceivableLine {
  quantityOrdered: number;
  quantityReceived: number;
}

/**
 * What is still owed on a line, never below zero.
 *
 * Over-receipt is allowed (see `receivePurchaseOrderInputSchema`), so received
 * can exceed ordered. Reporting that as a negative outstanding would put "we are
 * owed minus two" on a screen, which reads as a bug rather than as a supplier
 * who shipped a spare.
 */
export function outstandingQuantity(line: ReceivableLine): number {
  return Math.max(0, line.quantityOrdered - line.quantityReceived);
}

/** Complete once at least what was ordered has arrived. */
export function isLineComplete(line: ReceivableLine): boolean {
  return line.quantityReceived >= line.quantityOrdered;
}

/**
 * The order's status implied by its lines. Total, and the only writer of
 * `sent`/`partial`/`received` after a receipt or a reversal.
 *
 * It is derived rather than stepped forward because a receipt can be reversed.
 * A status advanced by hand would go `sent -> partial` on the way out and have
 * no idea how to come back when the receipt that made it partial is undone;
 * deriving means the same function answers both directions and the status can
 * never disagree with the quantities beneath it.
 *
 * `draft` and `cancelled` are returned untouched. Neither is a statement about
 * how much has arrived, so no quantity should be able to change them.
 */
export function derivePurchaseOrderStatus(
  lines: readonly ReceivableLine[],
  current: PurchaseOrderStatus,
): PurchaseOrderStatus {
  if (current === 'draft' || current === 'cancelled') return current;
  if (!lines.some((line) => line.quantityReceived > 0)) return 'sent';
  return lines.every(isLineComplete) ? 'received' : 'partial';
}

export function purchaseOrderTotalCents(
  lines: readonly { quantityOrdered: number; unitCostCents: number }[],
): number {
  return lines.reduce((sum, line) => sum + line.quantityOrdered * line.unitCostCents, 0);
}

export const purchaseOrderLineSchema = z.object({
  id: objectIdSchema,
  itemId: objectIdSchema,
  /**
   * Copied when the line is written, not resolved when it is read. A purchase
   * order is a document that went to somebody else, and it has to read
   * afterwards the way it read when it was sent — the same reasoning a movement
   * uses for its item. The id is still here, so the item's current name is one
   * lookup away for anyone who wants it.
   */
  itemSku: z.string(),
  itemName: z.string(),
  quantityOrdered: z.number().int(),
  quantityReceived: z.number().int(),
  /** Derived: ordered minus received, floored at zero. */
  quantityOutstanding: z.number().int(),
  /** Agreed price per unit at the time of ordering, in minor units. */
  unitCostCents: z.number().int(),
  /** Derived: ordered x unit cost. What the line commits, not what has landed. */
  lineTotalCents: z.number().int(),
});
export type PurchaseOrderLine = z.infer<typeof purchaseOrderLineSchema>;

export const purchaseOrderSchema = z.object({
  id: objectIdSchema,
  /** Sequential and human-quotable. This is what goes on the supplier's copy. */
  number: z.string(),
  supplierId: objectIdSchema,
  supplierCode: z.string(),
  supplierName: z.string(),
  status: purchaseOrderStatusSchema,
  /** When the supplier says it will arrive. Null until anyone knows. */
  expectedDate: isoDateSchema.nullable(),
  /** The supplier's own quote or order reference, if they gave one. */
  reference: z.string(),
  note: z.string(),
  lines: z.array(purchaseOrderLineSchema),
  /** Derived: the sum of the line totals. */
  totalCents: z.number().int(),
  /**
   * When it went to the supplier. Kept because measured lead time is the gap
   * between this and the receipts against it, and the analytics epic exists to
   * compare that against what the supplier promised.
   */
  sentAt: isoDateSchema.nullable(),
  /** When it reached `received` or `cancelled`. Cleared if a reversal reopens it. */
  closedAt: isoDateSchema.nullable(),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
});
export type PurchaseOrder = z.infer<typeof purchaseOrderSchema>;

export const purchaseOrderLineInputSchema = z.object({
  itemId: objectIdSchema,
  quantity: orderedQuantitySchema,
  unitCostCents: moneyCentsSchema.default(0),
});
export type PurchaseOrderLineInput = z.infer<typeof purchaseOrderLineInputSchema>;

/**
 * A new order starts as a draft, and a draft with no lines is legitimate — you
 * open one and add to it. Sending an empty one is what gets refused.
 */
export const createPurchaseOrderInputSchema = z.object({
  supplierId: objectIdSchema,
  expectedDate: isoDateSchema.nullable().default(null),
  reference: z.string().trim().max(120).default(''),
  note: z.string().trim().max(2000).default(''),
  lines: z.array(purchaseOrderLineInputSchema).max(500).default([]),
});
export type CreatePurchaseOrderInput = z.infer<typeof createPurchaseOrderInputSchema>;

/**
 * Lines may only be replaced while the order is a draft; the date and the notes
 * stay editable after it is sent, because a slipped delivery date is the most
 * ordinary thing that happens to a purchase order.
 */
export const updatePurchaseOrderInputSchema = z.object({
  supplierId: objectIdSchema.optional(),
  expectedDate: isoDateSchema.nullable().optional(),
  reference: z.string().trim().max(120).optional(),
  note: z.string().trim().max(2000).optional(),
  lines: z.array(purchaseOrderLineInputSchema).max(500).optional(),
});
export type UpdatePurchaseOrderInput = z.infer<typeof updatePurchaseOrderInputSchema>;

export const receivePurchaseOrderLineInputSchema = z.object({
  lineId: objectIdSchema,
  /** A magnitude. The server decides the sign, as every movement input does. */
  quantity: positiveQuantitySchema,
});
export type ReceivePurchaseOrderLineInput = z.infer<typeof receivePurchaseOrderLineInputSchema>;

/**
 * One delivery, which is one or more lines off the same order arriving together.
 *
 * Partial delivery is the normal case and needs no flag: you name the lines that
 * turned up and the quantities that turned up, and the order works out what that
 * leaves it as. Naming every line with its full quantity is the same operation
 * with nothing left over.
 *
 * Receiving more than was ordered is allowed. `POST /movements/issue` already
 * argues the general case — refusing an entry does not stop the stock moving, it
 * only stops the ledger hearing about it — and a supplier shipping a spare is
 * exactly that: the units are on the shelf whether or not this endpoint agrees
 * they should be. The excess is visible as received exceeding ordered rather
 * than hidden.
 */
export const receivePurchaseOrderInputSchema = z
  .object({
    /** Where the goods physically landed. One delivery, one bin. */
    locationId: objectIdSchema,
    lines: z
      .array(receivePurchaseOrderLineInputSchema)
      .min(1, 'Name at least one line to receive'),
    note: z.string().trim().max(500).default(''),
    /** Backdating is legitimate — paperwork arrives after the van does. */
    occurredAt: isoDateSchema.optional(),
  })
  // Two entries for one line in one delivery would post two movements and add
  // both, which is defensible but far more often a double submit. Say so.
  .refine((v) => new Set(v.lines.map((line) => line.lineId)).size === v.lines.length, {
    message: 'Each line can only appear once in one delivery',
    path: ['lines'],
  });
export type ReceivePurchaseOrderInput = z.infer<typeof receivePurchaseOrderInputSchema>;

export const PURCHASE_ORDER_SORT_FIELDS = [
  'number',
  'expectedDate',
  'status',
  'updatedAt',
] as const;
export const purchaseOrderSortFieldSchema = z.enum(PURCHASE_ORDER_SORT_FIELDS);
export type PurchaseOrderSortField = z.infer<typeof purchaseOrderSortFieldSchema>;

export const listPurchaseOrdersQuerySchema = paginationQuerySchema.extend({
  /** Matches the order number, or the supplier code or name recorded on it. */
  q: z.string().trim().max(200).optional(),
  status: purchaseOrderStatusSchema.optional(),
  supplierId: objectIdSchema.optional(),
  /** Orders carrying a line for this item — "what is already on the way". */
  itemId: objectIdSchema.optional(),
  /** Everything not yet received or cancelled. */
  open: z.coerce.boolean().optional(),
  sort: purchaseOrderSortFieldSchema.default('updatedAt'),
  order: sortOrderSchema.default('desc'),
});
export type ListPurchaseOrdersQuery = z.infer<typeof listPurchaseOrdersQuerySchema>;

export const purchaseOrderListResponseSchema = paginatedSchema(purchaseOrderSchema);
export type PurchaseOrderListResponse = z.infer<typeof purchaseOrderListResponseSchema>;

/**
 * What a receipt answers with: the order as it now stands, and every ledger row
 * the delivery wrote, each with the balance it produced.
 */
export const receivePurchaseOrderResponseSchema = z.object({
  purchaseOrder: purchaseOrderSchema,
  movements: z.array(
    z.object({ movement: movementSchema, balanceAfter: z.number().int() }),
  ),
});
export type ReceivePurchaseOrderResponse = z.infer<typeof receivePurchaseOrderResponseSchema>;
