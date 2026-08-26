/**
 * Would this movement take a bin negative, and how do we say so.
 *
 * A warning, never a refusal. The API posts the movement either way and says
 * why in `POST /movements/issue`: stock physically leaves before the paperwork
 * catches up, and blocking the entry means it never gets recorded at all — the
 * ledger then diverges from reality silently, which is worse than a visible
 * negative. So nothing in here disables a submit; it only produces text.
 *
 * Deliberately free of imports so the maths can be tested on its own, without
 * a DOM or a server.
 */

/** The shape of one row of `GET /movements/stock/:itemId`'s breakdown. */
export interface StockAtLocation {
  locationId: string;
  onHand: number;
}

/**
 * On-hand for one bin, from the per-item breakdown.
 *
 * A bin missing from the breakdown has simply never held this item, which is
 * zero — not unknown. The caller distinguishes "not loaded yet" by not calling.
 */
export function onHandAt(levels: readonly StockAtLocation[], locationId: string): number {
  return levels.find((level) => level.locationId === locationId)?.onHand ?? 0;
}

/** Where a bin lands if this movement is posted. `delta` is signed. */
export function projectedBalance(onHand: number, delta: number): number {
  return onHand + delta;
}

/**
 * The sentence to show beside a quantity that would overdraw a bin, or null.
 *
 * Only outbound movements warn. Receiving into a bin that is already negative
 * moves it towards zero, and calling that a problem trains people to ignore the
 * warning that matters.
 */
export function negativeStockWarning(args: {
  locationCode: string;
  onHand: number;
  delta: number;
}): string | null {
  if (args.delta >= 0) return null;
  const balance = projectedBalance(args.onHand, args.delta);
  if (balance >= 0) return null;
  return `${args.locationCode} holds ${args.onHand.toLocaleString()}. This takes it to ${balance.toLocaleString()}.`;
}

/** The standing explanation under any such warning, so the tone is consistent. */
export const NEGATIVE_STOCK_EXPLANATION =
  'Recorded anyway. Stock often leaves before the paperwork, and a negative you can see beats a movement nobody wrote down.';
