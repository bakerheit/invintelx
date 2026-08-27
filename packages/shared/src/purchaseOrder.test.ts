import { describe, expect, it } from 'vitest';
import {
  PURCHASE_ORDER_STATUSES,
  canCancel,
  canEditLines,
  canReceive,
  canSend,
  canTransition,
  createPurchaseOrderInputSchema,
  derivePurchaseOrderStatus,
  formatPurchaseOrderNumber,
  isClosedPurchaseOrder,
  isLineComplete,
  outstandingQuantity,
  purchaseOrderTotalCents,
  receivePurchaseOrderInputSchema,
  updatePurchaseOrderInputSchema,
  type PurchaseOrderStatus,
} from './purchaseOrder.js';

const OID = '507f1f77bcf86cd799439011';
const OTHER_OID = '507f1f77bcf86cd799439012';

function line(ordered: number, received: number) {
  return { quantityOrdered: ordered, quantityReceived: received };
}

describe('purchase order status transitions', () => {
  it('lets a draft be sent or cancelled and nothing else', () => {
    expect(canTransition('draft', 'sent')).toBe(true);
    expect(canTransition('draft', 'cancelled')).toBe(true);
    expect(canTransition('draft', 'received')).toBe(false);
    expect(canTransition('draft', 'partial')).toBe(false);
  });

  it('treats received and cancelled as terminal', () => {
    for (const status of PURCHASE_ORDER_STATUSES) {
      expect(canTransition('received', status)).toBe(false);
      expect(canTransition('cancelled', status)).toBe(false);
    }
    expect(isClosedPurchaseOrder('received')).toBe(true);
    expect(isClosedPurchaseOrder('cancelled')).toBe(true);
    expect(isClosedPurchaseOrder('partial')).toBe(false);
  });

  it('only takes a receipt against a sent or partial order', () => {
    const receivable = PURCHASE_ORDER_STATUSES.filter(canReceive);
    expect(receivable).toEqual(['sent', 'partial']);
  });

  it('only sends and only edits lines while a draft', () => {
    expect(PURCHASE_ORDER_STATUSES.filter(canSend)).toEqual(['draft']);
    expect(PURCHASE_ORDER_STATUSES.filter(canEditLines)).toEqual(['draft']);
  });

  it('allows cancelling a part-delivered order', () => {
    expect(canCancel('partial')).toBe(true);
    expect(canCancel('received')).toBe(false);
  });
});

describe('derivePurchaseOrderStatus', () => {
  it('stays sent while nothing has arrived', () => {
    expect(derivePurchaseOrderStatus([line(10, 0), line(5, 0)], 'sent')).toBe('sent');
  });

  it('is partial when some but not all of the order has landed', () => {
    expect(derivePurchaseOrderStatus([line(10, 4), line(5, 0)], 'sent')).toBe('partial');
    expect(derivePurchaseOrderStatus([line(10, 10), line(5, 0)], 'sent')).toBe('partial');
  });

  it('is received once every line is complete', () => {
    expect(derivePurchaseOrderStatus([line(10, 10), line(5, 5)], 'partial')).toBe('received');
  });

  it('counts an over-shipped line as complete', () => {
    expect(derivePurchaseOrderStatus([line(10, 12), line(5, 5)], 'partial')).toBe('received');
  });

  it('comes back down when a receipt is reversed', () => {
    // The same function answers both directions, which is the whole reason the
    // status is derived rather than stepped forward.
    expect(derivePurchaseOrderStatus([line(10, 4), line(5, 5)], 'received')).toBe('partial');
    expect(derivePurchaseOrderStatus([line(10, 0), line(5, 0)], 'received')).toBe('sent');
  });

  it('never lets a quantity move a draft or a cancelled order', () => {
    expect(derivePurchaseOrderStatus([line(10, 10)], 'draft')).toBe('draft');
    expect(derivePurchaseOrderStatus([line(10, 4)], 'cancelled')).toBe('cancelled');
    expect(derivePurchaseOrderStatus([line(10, 0)], 'cancelled')).toBe('cancelled');
  });

  it('is total over every status', () => {
    for (const status of PURCHASE_ORDER_STATUSES) {
      const next: PurchaseOrderStatus = derivePurchaseOrderStatus([line(1, 1)], status);
      expect(PURCHASE_ORDER_STATUSES).toContain(next);
    }
  });
});

describe('line arithmetic', () => {
  it('reports what is still owed', () => {
    expect(outstandingQuantity(line(10, 4))).toBe(6);
    expect(outstandingQuantity(line(10, 10))).toBe(0);
  });

  it('floors an over-shipped line at zero rather than owing minus two', () => {
    expect(outstandingQuantity(line(10, 12))).toBe(0);
  });

  it('calls a line complete once at least the ordered quantity has arrived', () => {
    expect(isLineComplete(line(10, 9))).toBe(false);
    expect(isLineComplete(line(10, 10))).toBe(true);
    expect(isLineComplete(line(10, 11))).toBe(true);
  });

  it('totals what the order commits, not what has landed', () => {
    expect(
      purchaseOrderTotalCents([
        { quantityOrdered: 10, unitCostCents: 250 },
        { quantityOrdered: 3, unitCostCents: 1000 },
      ]),
    ).toBe(5500);
    expect(purchaseOrderTotalCents([])).toBe(0);
  });
});

describe('formatPurchaseOrderNumber', () => {
  it('zero-pads so the numbers sort as text', () => {
    expect(formatPurchaseOrderNumber(1)).toBe('PO-00001');
    expect(formatPurchaseOrderNumber(42)).toBe('PO-00042');
    expect([formatPurchaseOrderNumber(9), formatPurchaseOrderNumber(10)].sort()).toEqual([
      'PO-00009',
      'PO-00010',
    ]);
  });

  it('keeps going past the padding rather than truncating', () => {
    expect(formatPurchaseOrderNumber(1234567)).toBe('PO-1234567');
  });
});

describe('createPurchaseOrderInputSchema', () => {
  it('accepts a draft with no lines', () => {
    const parsed = createPurchaseOrderInputSchema.parse({ supplierId: OID });
    expect(parsed.lines).toEqual([]);
    expect(parsed.expectedDate).toBeNull();
    expect(parsed.reference).toBe('');
  });

  it('requires a supplier', () => {
    expect(createPurchaseOrderInputSchema.safeParse({ lines: [] }).success).toBe(false);
  });

  it('defaults a line price to zero rather than refusing a price nobody knows yet', () => {
    const parsed = createPurchaseOrderInputSchema.parse({
      supplierId: OID,
      lines: [{ itemId: OTHER_OID, quantity: 5 }],
    });
    expect(parsed.lines[0]?.unitCostCents).toBe(0);
  });

  it('refuses a zero or negative order quantity', () => {
    for (const quantity of [0, -1, 2.5]) {
      const result = createPurchaseOrderInputSchema.safeParse({
        supplierId: OID,
        lines: [{ itemId: OTHER_OID, quantity }],
      });
      expect(result.success).toBe(false);
    }
  });

  it('refuses a fractional price in minor units', () => {
    const result = createPurchaseOrderInputSchema.safeParse({
      supplierId: OID,
      lines: [{ itemId: OTHER_OID, quantity: 1, unitCostCents: 12.5 }],
    });
    expect(result.success).toBe(false);
  });
});

describe('updatePurchaseOrderInputSchema', () => {
  it('leaves out what was not sent, so a note edit cannot blank the lines', () => {
    const parsed = updatePurchaseOrderInputSchema.parse({ note: 'called them' });
    expect(parsed).toEqual({ note: 'called them' });
    expect('lines' in parsed).toBe(false);
  });

  it('accepts an expected date being cleared', () => {
    expect(updatePurchaseOrderInputSchema.parse({ expectedDate: null }).expectedDate).toBeNull();
  });
});

describe('receivePurchaseOrderInputSchema', () => {
  it('takes a magnitude and refuses a signed quantity', () => {
    const good = receivePurchaseOrderInputSchema.safeParse({
      locationId: OID,
      lines: [{ lineId: OTHER_OID, quantity: 4 }],
    });
    expect(good.success).toBe(true);

    const signed = receivePurchaseOrderInputSchema.safeParse({
      locationId: OID,
      lines: [{ lineId: OTHER_OID, quantity: -4 }],
    });
    expect(signed.success).toBe(false);
  });

  it('refuses a delivery that names no lines', () => {
    const result = receivePurchaseOrderInputSchema.safeParse({ locationId: OID, lines: [] });
    expect(result.success).toBe(false);
  });

  it('refuses the same line twice in one delivery', () => {
    const result = receivePurchaseOrderInputSchema.safeParse({
      locationId: OID,
      lines: [
        { lineId: OTHER_OID, quantity: 1 },
        { lineId: OTHER_OID, quantity: 2 },
      ],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe('Each line can only appear once in one delivery');
  });
});
