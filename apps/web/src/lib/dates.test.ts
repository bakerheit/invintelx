import { describe, expect, it } from 'vitest';
import { formatMovementDate } from './dates';

describe('formatMovementDate', () => {
  it('renders the UTC day, so history agrees with the demand buckets', () => {
    /*
     * 01:05 UTC on 26 August is still 25 August in New York. The demand series
     * groups by UTC day, so rendering this locally would file the same movement
     * under two different dates depending on where the reader sits.
     */
    expect(formatMovementDate('2026-08-26T01:05:00.000Z')).toBe('Aug 26, 2026');
  });

  it('does not shift a late-evening UTC timestamp either', () => {
    expect(formatMovementDate('2026-08-26T23:50:00.000Z')).toBe('Aug 26, 2026');
  });

  it('does not roll the year back for a timestamp just after midnight UTC', () => {
    expect(formatMovementDate('2027-01-01T00:30:00.000Z')).toBe('Jan 1, 2027');
  });

  it('does not roll the year forward for a timestamp just before it', () => {
    expect(formatMovementDate('2026-12-31T23:30:00.000Z')).toBe('Dec 31, 2026');
  });
});
