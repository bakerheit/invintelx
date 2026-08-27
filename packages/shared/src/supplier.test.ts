import { describe, expect, it } from 'vitest';
import { DEFAULT_LEAD_TIME_DAYS } from './analytics.js';
import {
  createSupplierInputSchema,
  createSupplierItemInputSchema,
  currencySchema,
  paymentDueDays,
  priceBreaksSchema,
  priceForQuantity,
  supplierCodeSchema,
  supplierSkuSchema,
  updateSupplierInputSchema,
} from './supplier.js';

describe('supplierCodeSchema', () => {
  it('uppercases and trims, so casing cannot create a duplicate supplier', () => {
    expect(supplierCodeSchema.parse('  acme-1  ')).toBe('ACME-1');
  });

  it('rejects an empty code and one with a space in it', () => {
    expect(supplierCodeSchema.safeParse('').success).toBe(false);
    expect(supplierCodeSchema.safeParse('has space').success).toBe(false);
  });
});

describe('supplierSkuSchema', () => {
  it("keeps the supplier's own casing, because it goes on their purchase order", () => {
    expect(supplierSkuSchema.parse('  aBc-99 ')).toBe('aBc-99');
  });

  it('accepts punctuation our own SKUs refuse, since the format is theirs', () => {
    expect(supplierSkuSchema.parse('AB/12 34')).toBe('AB/12 34');
  });
});

describe('currencySchema', () => {
  it('normalises to upper case ISO 4217', () => {
    expect(currencySchema.parse('usd')).toBe('USD');
  });

  it('rejects anything that is not three letters', () => {
    expect(currencySchema.safeParse('DOLLARS').success).toBe(false);
    expect(currencySchema.safeParse('US').success).toBe(false);
    expect(currencySchema.safeParse('12').success).toBe(false);
  });
});

describe('paymentDueDays', () => {
  it('turns a term into the number a cash-flow forecast needs', () => {
    expect(paymentDueDays('net_30')).toBe(30);
    expect(paymentDueDays('cod')).toBe(0);
    expect(paymentDueDays('prepaid')).toBe(0);
  });

  it('answers null for "other" rather than pretending it is due today', () => {
    expect(paymentDueDays('other')).toBeNull();
  });
});

describe('createSupplierInputSchema', () => {
  it('fills every optional field so the document shape is never partial', () => {
    const parsed = createSupplierInputSchema.parse({ code: 'acme', name: 'Acme Supplies' });
    expect(parsed).toMatchObject({
      code: 'ACME',
      name: 'Acme Supplies',
      paymentTerms: 'net_30',
      currency: 'USD',
      notes: '',
      contact: { name: '', email: '', phone: '', website: '', address: '' },
    });
  });

  it('defaults the promised lead time to what analytics already assumes', () => {
    const parsed = createSupplierInputSchema.parse({ code: 'acme', name: 'Acme' });
    expect(parsed.promisedLeadTimeDays).toBe(DEFAULT_LEAD_TIME_DAYS);
  });

  it('lowercases a contact email but leaves a blank one blank', () => {
    expect(
      createSupplierInputSchema.parse({
        code: 'a1',
        name: 'A',
        contact: { email: '  Sales@ACME.example  ' },
      }).contact.email,
    ).toBe('sales@acme.example');
    expect(createSupplierInputSchema.parse({ code: 'a1', name: 'A' }).contact.email).toBe('');
  });

  it('rejects a contact email that is not an address', () => {
    const result = createSupplierInputSchema.safeParse({
      code: 'a1',
      name: 'A',
      contact: { email: 'not-an-address' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a website without a scheme, which would resolve relative to us', () => {
    expect(
      createSupplierInputSchema.safeParse({
        code: 'a1',
        name: 'A',
        contact: { website: 'acme.example' },
      }).success,
    ).toBe(false);
    expect(
      createSupplierInputSchema.safeParse({
        code: 'a1',
        name: 'A',
        contact: { website: 'https://acme.example' },
      }).success,
    ).toBe(true);
  });

  it('refuses a fractional or negative lead time', () => {
    const base = { code: 'a1', name: 'A' };
    expect(createSupplierInputSchema.safeParse({ ...base, promisedLeadTimeDays: 2.5 }).success).toBe(
      false,
    );
    expect(createSupplierInputSchema.safeParse({ ...base, promisedLeadTimeDays: -1 }).success).toBe(
      false,
    );
  });
});

describe('updateSupplierInputSchema', () => {
  it('leaves unmentioned contact fields absent instead of defaulting them to blank', () => {
    const parsed = updateSupplierInputSchema.parse({ contact: { phone: '0100 000000' } });
    expect(parsed.contact).toEqual({ phone: '0100 000000' });
    expect(parsed.contact && 'email' in parsed.contact).toBe(false);
  });

  it('accepts an empty patch, which changes nothing', () => {
    expect(updateSupplierInputSchema.parse({})).toEqual({});
  });
});

describe('priceBreaksSchema', () => {
  it('sorts the ladder ascending, so storage is canonical', () => {
    const parsed = priceBreaksSchema.parse([
      { minQuantity: 100, unitPriceCents: 80 },
      { minQuantity: 1, unitPriceCents: 100 },
      { minQuantity: 10, unitPriceCents: 90 },
    ]);
    expect(parsed.map((brk) => brk.minQuantity)).toEqual([1, 10, 100]);
  });

  it('rejects two rungs starting at the same quantity', () => {
    const result = priceBreaksSchema.safeParse([
      { minQuantity: 10, unitPriceCents: 90 },
      { minQuantity: 10, unitPriceCents: 80 },
    ]);
    expect(result.success).toBe(false);
  });

  it('allows an empty ladder, which is "price on application"', () => {
    expect(priceBreaksSchema.parse([])).toEqual([]);
  });

  it('rejects a rung starting below one, and a fractional price', () => {
    expect(priceBreaksSchema.safeParse([{ minQuantity: 0, unitPriceCents: 90 }]).success).toBe(
      false,
    );
    expect(priceBreaksSchema.safeParse([{ minQuantity: 1, unitPriceCents: 9.5 }]).success).toBe(
      false,
    );
  });
});

describe('priceForQuantity', () => {
  const ladder = priceBreaksSchema.parse([
    { minQuantity: 1, unitPriceCents: 100 },
    { minQuantity: 10, unitPriceCents: 90 },
    { minQuantity: 100, unitPriceCents: 80 },
  ]);

  it('picks the highest rung the quantity reaches', () => {
    expect(priceForQuantity(ladder, 1)).toBe(100);
    expect(priceForQuantity(ladder, 9)).toBe(100);
    expect(priceForQuantity(ladder, 10)).toBe(90);
    expect(priceForQuantity(ladder, 99)).toBe(90);
    expect(priceForQuantity(ladder, 1000)).toBe(80);
  });

  it('says null below the lowest rung rather than inventing a price', () => {
    const fromTwelve = priceBreaksSchema.parse([{ minQuantity: 12, unitPriceCents: 500 }]);
    expect(priceForQuantity(fromTwelve, 5)).toBeNull();
    expect(priceForQuantity(fromTwelve, 12)).toBe(500);
  });

  it('says null when there is no ladder at all', () => {
    expect(priceForQuantity([], 100)).toBeNull();
  });

  it('does not depend on the ladder arriving sorted', () => {
    expect(
      priceForQuantity(
        [
          { minQuantity: 100, unitPriceCents: 80 },
          { minQuantity: 1, unitPriceCents: 100 },
        ],
        150,
      ),
    ).toBe(80);
  });
});

describe('createSupplierItemInputSchema', () => {
  it('defaults to no price breaks', () => {
    const parsed = createSupplierItemInputSchema.parse({
      itemId: 'a'.repeat(24),
      supplierSku: 'THEIR-1',
    });
    expect(parsed.priceBreaks).toEqual([]);
  });

  it('rejects an itemId that is not an object id', () => {
    expect(
      createSupplierItemInputSchema.safeParse({ itemId: 'nope', supplierSku: 'THEIR-1' }).success,
    ).toBe(false);
  });
});
