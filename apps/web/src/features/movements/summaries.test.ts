import { describe, expect, it } from 'vitest';
import {
  adjustedSentence,
  balanceSentence,
  postedSentence,
  reversedSentence,
  transferredSentence,
} from './summaries';

describe('balanceSentence', () => {
  it('says where the bin stands', () => {
    expect(balanceSentence('A-01', 125)).toBe('A-01 now holds 125.');
  });

  it('says so plainly when the bin is negative rather than hiding it', () => {
    expect(balanceSentence('A-01', -6)).toBe('A-01 now holds -6.');
  });
});

describe('postedSentence', () => {
  it('reads as a receipt', () => {
    expect(
      postedSentence({
        verb: 'Received',
        quantity: 25,
        sku: 'BOLT-M6-30',
        preposition: 'into',
        locationCode: 'A-01',
      }),
    ).toBe('Received 25 of BOLT-M6-30 into A-01.');
  });

  it('reads as an issue', () => {
    expect(
      postedSentence({
        verb: 'Issued',
        quantity: 10,
        sku: 'BOLT-M6-30',
        preposition: 'from',
        locationCode: 'A-01',
      }),
    ).toBe('Issued 10 of BOLT-M6-30 from A-01.');
  });
});

describe('transferredSentence', () => {
  it('names both ends, in the order the stock travelled', () => {
    expect(
      transferredSentence({ quantity: 5, sku: 'BOLT-M6-30', fromCode: 'A-01', toCode: 'B-02' }),
    ).toBe('Moved 5 of BOLT-M6-30 from A-01 to B-02.');
  });
});

describe('adjustedSentence', () => {
  /*
   * The direction is read off the signed quantity the ledger wrote, not off the
   * dropdown the form had — those are the same thing right up until they are
   * not, and the sentence has to describe what happened.
   */
  it('describes a write-off from the negative the ledger recorded', () => {
    expect(
      adjustedSentence({
        signedQuantity: -3,
        sku: 'BOLT-M6-30',
        locationCode: 'A-01',
        reason: 'miscount',
      }),
    ).toBe('Wrote 3 of BOLT-M6-30 off A-01 (miscount).');
  });

  it('describes a write-on from the positive', () => {
    expect(
      adjustedSentence({
        signedQuantity: 3,
        sku: 'BOLT-M6-30',
        locationCode: 'A-01',
        reason: 'found',
      }),
    ).toBe('Wrote 3 of BOLT-M6-30 onto A-01 (found).');
  });
});

describe('reversedSentence', () => {
  it('states the size of what was undone, whichever way the original went', () => {
    expect(reversedSentence({ quantity: -25, sku: 'BOLT-M6-30', locationCode: 'A-01' })).toBe(
      'Reversed 25 of BOLT-M6-30 at A-01.',
    );
    expect(reversedSentence({ quantity: 25, sku: 'BOLT-M6-30', locationCode: 'A-01' })).toBe(
      'Reversed 25 of BOLT-M6-30 at A-01.',
    );
  });
});
