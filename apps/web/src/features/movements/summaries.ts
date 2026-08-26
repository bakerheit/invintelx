/**
 * The sentences a movement screen says after a write.
 *
 * Pulled out of the components because they are the answer to "did that do what
 * I meant", and getting the sign or the bin wrong in one of them is a quiet way
 * to have somebody trust a number that is not true. No imports, so they can be
 * checked on their own.
 */

/** Where a bin stands now. `balance` comes back from the write, not a re-read. */
export function balanceSentence(locationCode: string, balance: number): string {
  return `${locationCode} now holds ${balance.toLocaleString()}.`;
}

/** "Received 25 of BOLT-M6-30 into A-01." */
export function postedSentence(args: {
  verb: string;
  quantity: number;
  sku: string;
  preposition: string;
  locationCode: string;
}): string {
  return `${args.verb} ${args.quantity.toLocaleString()} of ${args.sku} ${args.preposition} ${args.locationCode}.`;
}

/** "Moved 5 of BOLT-M6-30 from A-01 to B-02." */
export function transferredSentence(args: {
  quantity: number;
  sku: string;
  fromCode: string;
  toCode: string;
}): string {
  return `Moved ${args.quantity.toLocaleString()} of ${args.sku} from ${args.fromCode} to ${args.toCode}.`;
}

/**
 * "Wrote 3 of BOLT-M6-30 off A-01 (miscount)."
 *
 * The signed quantity is what came back from the ledger, so this reads the
 * direction off the movement that was actually written rather than off what the
 * form thought it was sending.
 */
export function adjustedSentence(args: {
  signedQuantity: number;
  sku: string;
  locationCode: string;
  reason: string;
}): string {
  const magnitude = Math.abs(args.signedQuantity).toLocaleString();
  const direction = args.signedQuantity < 0 ? 'off' : 'onto';
  return `Wrote ${magnitude} of ${args.sku} ${direction} ${args.locationCode} (${args.reason}).`;
}

/** "Reversed 25 of BOLT-M6-30 at A-01." */
export function reversedSentence(args: {
  quantity: number;
  sku: string;
  locationCode: string;
}): string {
  return `Reversed ${Math.abs(args.quantity).toLocaleString()} of ${args.sku} at ${args.locationCode}.`;
}
