import { describe, expect, it } from 'vitest';
import { centsToDecimal, decimalToCents, formatCents } from './money.js';

describe('money', () => {
  it('round-trips a decimal through cents without drift', () => {
    for (const amount of [0, 0.01, 12.5, 29.99, 1234.56]) {
      expect(centsToDecimal(decimalToCents(amount))).toBe(amount);
    }
  });

  it('rounds rather than truncating, so 0.1 + 0.2 style input lands correctly', () => {
    // 29.99 * 100 is 2998.9999999999995 in floating point.
    expect(decimalToCents(29.99)).toBe(2999);
    expect(decimalToCents(1.005)).toBe(101);
  });

  it('formats as currency for display', () => {
    expect(formatCents(2999)).toBe('$29.99');
    expect(formatCents(0)).toBe('$0.00');
  });
});
