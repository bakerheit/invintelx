/**
 * Money is stored and transported as integer minor units (cents).
 *
 * Inventory valuation sums quantity x unit cost across every SKU in the
 * business. Doing that in floating point accumulates drift that shows up as a
 * total nobody can reconcile against the accounts, so the wire format is
 * integers and only the presentation layer sees a decimal.
 */

export function centsToDecimal(cents: number): number {
  return cents / 100;
}

export function decimalToCents(amount: number): number {
  /*
   * `amount * 100` alone is not enough. 1.005 is stored as 1.00499999... so the
   * product is 100.49999999999999 and Math.round gives 100 - a cent short of
   * what the person typing "1.005" meant.
   *
   * Fixing the product to 4 decimal places first collapses that representation
   * error, then the rounding does what a human expects.
   */
  return Math.round(Number((amount * 100).toFixed(4)));
}

export function formatCents(cents: number, currency = 'USD', locale = 'en-US'): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(cents / 100);
}
