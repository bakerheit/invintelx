import { describe, expect, it } from 'vitest';
import {
  MAX_MOVEMENT_QUANTITY,
  quantityError,
  signedAdjustment,
  toQuantity,
} from './quantity';

describe('quantityError', () => {
  it('accepts a whole number of units', () => {
    expect(quantityError('12')).toBeNull();
  });

  it('accepts a pasted value with whitespace around it', () => {
    expect(quantityError('  12  ')).toBeNull();
  });

  it('asks for a quantity when the box is empty', () => {
    expect(quantityError('')).toBe('Enter a quantity');
    expect(quantityError('   ')).toBe('Enter a quantity');
  });

  it('refuses a fraction of a unit', () => {
    expect(quantityError('3.5')).toBe('Whole units only');
  });

  /*
   * A minus sign is a typo, never an instruction. Direction lives on the screen
   * — a receipt adds, an issue removes — so accepting "-3" here would let an
   * issue of minus three quietly become a receipt.
   */
  it('refuses a signed quantity rather than reading it as a direction', () => {
    expect(quantityError('-3')).toBe('Whole units only');
  });

  it('refuses exponent notation, which a number input will happily produce', () => {
    expect(quantityError('1e3')).toBe('Whole units only');
  });

  it('refuses zero, which would record nothing', () => {
    expect(quantityError('0')).toBe('Enter at least 1');
  });

  it('accepts the largest quantity the ledger takes, and refuses one more', () => {
    expect(quantityError(String(MAX_MOVEMENT_QUANTITY))).toBeNull();
    expect(quantityError(String(MAX_MOVEMENT_QUANTITY + 1))).toBe('That is implausibly large');
  });
});

describe('toQuantity', () => {
  it('reads leading zeros as the number somebody meant', () => {
    expect(toQuantity('007')).toBe(7);
  });
});

describe('signedAdjustment', () => {
  it('writes stock off as a negative', () => {
    expect(signedAdjustment('decrease', 3)).toBe(-3);
  });

  it('writes stock on as a positive', () => {
    expect(signedAdjustment('increase', 3)).toBe(3);
  });
});
