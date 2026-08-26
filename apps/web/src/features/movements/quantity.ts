/**
 * What a person typed into a quantity box, and what the ledger should make of it.
 *
 * Kept as text right up to the boundary. `<input type="number">` hands back a
 * string whatever it is styled as, and a browser will happily produce "1e3",
 * "3.5" or "" — so this decides, once, what counts as a quantity rather than
 * leaving each form to coerce and hope.
 *
 * Deliberately free of imports, so the rules can be tested on their own.
 */

export const MAX_MOVEMENT_QUANTITY = 1_000_000_000;

/**
 * Why this is not a usable quantity, or null if it is one.
 *
 * Direction is never encoded here. Every screen carries it separately — a
 * receipt adds, an issue removes, an adjustment says which — so a minus sign in
 * the box is a typo, not an instruction.
 */
export function quantityError(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return 'Enter a quantity';
  if (!/^\d+$/.test(trimmed)) return 'Whole units only';
  const value = Number(trimmed);
  if (value < 1) return 'Enter at least 1';
  if (value > MAX_MOVEMENT_QUANTITY) return 'That is implausibly large';
  return null;
}

/** Only meaningful once `quantityError` has returned null. */
export function toQuantity(raw: string): number {
  return Number(raw.trim());
}

export type AdjustDirection = 'increase' | 'decrease';

/** Signed, the way the ledger wants it. */
export function signedAdjustment(direction: AdjustDirection, quantity: number): number {
  return direction === 'decrease' ? -quantity : quantity;
}
