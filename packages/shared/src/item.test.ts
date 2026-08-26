import { describe, expect, it } from 'vitest';
import { createItemInputSchema, listItemsQuerySchema, skuSchema } from './item.js';

describe('skuSchema', () => {
  it('uppercases and trims, so casing cannot create a duplicate SKU', () => {
    expect(skuSchema.parse('  abc-1  ')).toBe('ABC-1');
    expect(skuSchema.parse('ABC-1')).toBe('ABC-1');
  });

  it('rejects characters that would break barcode scanners and URLs', () => {
    expect(skuSchema.safeParse('has space').success).toBe(false);
    expect(skuSchema.safeParse('slash/es').success).toBe(false);
    expect(skuSchema.safeParse('').success).toBe(false);
  });

  it('accepts dot, dash and underscore', () => {
    expect(skuSchema.parse('a.b-c_1')).toBe('A.B-C_1');
  });
});

describe('createItemInputSchema', () => {
  it('fills every optional field so the document shape is never partial', () => {
    const parsed = createItemInputSchema.parse({ sku: 'x1', name: 'Thing' });
    expect(parsed).toMatchObject({
      sku: 'X1',
      description: '',
      category: '',
      unitOfMeasure: 'each',
      unitCostCents: 0,
      unitPriceCents: 0,
      reorderPoint: 0,
      reorderQuantity: 0,
      attributes: {},
    });
  });

  it('rejects fractional cents, which are not a thing that exists', () => {
    const result = createItemInputSchema.safeParse({ sku: 'x1', name: 'Thing', unitCostCents: 10.5 });
    expect(result.success).toBe(false);
  });

  it('rejects negative money', () => {
    expect(
      createItemInputSchema.safeParse({ sku: 'x1', name: 'T', unitPriceCents: -1 }).success,
    ).toBe(false);
  });
});

describe('listItemsQuerySchema', () => {
  it('coerces string query params, since that is all a URL can carry', () => {
    const parsed = listItemsQuerySchema.parse({ page: '3', pageSize: '50' });
    expect(parsed.page).toBe(3);
    expect(parsed.pageSize).toBe(50);
  });

  it('applies defaults when the URL carries nothing', () => {
    const parsed = listItemsQuerySchema.parse({});
    expect(parsed).toMatchObject({ page: 1, pageSize: 25, sort: 'updatedAt', order: 'desc' });
  });

  it('caps pageSize so one request cannot ask for the whole catalogue', () => {
    expect(listItemsQuerySchema.safeParse({ pageSize: '5000' }).success).toBe(false);
  });

  it('rejects a sort field that is not indexed or expected', () => {
    expect(listItemsQuerySchema.safeParse({ sort: 'passwordHash' }).success).toBe(false);
  });
});
