import { describe, expect, it } from 'vitest';
import { negativeStockWarning, onHandAt, projectedBalance } from './warnings';

const LEVELS = [
  { locationId: 'aaaaaaaaaaaaaaaaaaaaaaaa', onHand: 12 },
  { locationId: 'bbbbbbbbbbbbbbbbbbbbbbbb', onHand: 0 },
];

describe('onHandAt', () => {
  it('reads the balance for the bin asked for', () => {
    expect(onHandAt(LEVELS, 'aaaaaaaaaaaaaaaaaaaaaaaa')).toBe(12);
  });

  it('treats a bin that has never held the item as zero, not unknown', () => {
    expect(onHandAt(LEVELS, 'cccccccccccccccccccccccc')).toBe(0);
  });
});

describe('projectedBalance', () => {
  it('applies a signed delta', () => {
    expect(projectedBalance(12, -5)).toBe(7);
    expect(projectedBalance(12, 5)).toBe(17);
  });
});

describe('negativeStockWarning', () => {
  it('says nothing when the bin has enough', () => {
    expect(negativeStockWarning({ locationCode: 'A-01', onHand: 12, delta: -5 })).toBeNull();
  });

  it('says nothing when the issue lands exactly on zero', () => {
    expect(negativeStockWarning({ locationCode: 'A-01', onHand: 5, delta: -5 })).toBeNull();
  });

  it('names the bin and the balance it would reach when it goes under', () => {
    expect(negativeStockWarning({ locationCode: 'A-01', onHand: 4, delta: -10 })).toBe(
      'A-01 holds 4. This takes it to -6.',
    );
  });

  it('warns at one unit over, so the boundary is not silently skipped', () => {
    expect(negativeStockWarning({ locationCode: 'A-01', onHand: 5, delta: -6 })).toBe(
      'A-01 holds 5. This takes it to -1.',
    );
  });

  /*
   * The point of the whole helper: it is a warning, not a veto. If this ever
   * starts returning something the form treats as a blocker, the ledger goes
   * back to being the thing that quietly disagrees with the shelf.
   */
  it('stays quiet on an inbound movement, even into a bin already negative', () => {
    expect(negativeStockWarning({ locationCode: 'A-01', onHand: -3, delta: 2 })).toBeNull();
  });

  it('warns on an issue out of an already negative bin', () => {
    expect(negativeStockWarning({ locationCode: 'A-01', onHand: -3, delta: -2 })).toBe(
      'A-01 holds -3. This takes it to -5.',
    );
  });
});
