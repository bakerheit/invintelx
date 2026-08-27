/**
 * Telling a barcode scanner apart from a person, by timing alone.
 *
 * A keyboard-wedge scanner — which is most of them — is indistinguishable from
 * a keyboard except in one respect: it types a whole code in a few milliseconds
 * and finishes with Enter. Nobody types at 35ms a character, so a run of
 * keystrokes that fast, terminated by Enter, is a machine.
 *
 * The decision lives here, away from the DOM, because it is the part that has to
 * be exactly right: too eager and somebody's typing is swallowed, too shy and
 * the scan silently does nothing.
 */

/**
 * The gap that separates a machine from a person.
 *
 * Scanners land in the 5-20ms range; sustained human typing at 35ms a character
 * would be around 340 words a minute, which is roughly twice the world record.
 * Key auto-repeat also runs about this fast, so the caller has to drop repeats
 * before asking.
 */
export const SCAN_GAP_MS = 35;

/**
 * Shorter than this is not a scan.
 *
 * Guards the one plausible false positive left: a modifier chord or a stray
 * double-tap followed immediately by Enter. Every retail and industrial symbology
 * a warehouse uses carries at least six characters.
 */
export const MIN_CODE_LENGTH = 4;

/**
 * How much of a fast run is let through before the rest is held back.
 *
 * Suppressing from the first character would mean holding back every keystroke
 * until the timing proved it was a machine, and dropping a character somebody
 * meant to type is a worse bug than leaving a stray one behind. Three in a row
 * under `SCAN_GAP_MS` is already beyond a person; four is not a judgement call.
 * The stray prefix lands in the quantity box or the item search, both of which
 * the scan clears on its way through.
 */
const SUPPRESS_AFTER = 3;

export interface ScanBuffer {
  /** Characters seen so far in the current fast run. */
  readonly chars: string;
  /** When the last one arrived, on whatever clock the caller is using. */
  readonly lastAt: number;
}

export const EMPTY_SCAN_BUFFER: ScanBuffer = { chars: '', lastAt: 0 };

export interface ScanStep {
  readonly buffer: ScanBuffer;
  /** A complete code, if this keystroke finished one. */
  readonly scanned: string | null;
  /** Whether the keystroke should be kept out of whatever has focus. */
  readonly suppress: boolean;
}

/**
 * Advance the buffer by one keystroke.
 *
 * `key` is the DOM `KeyboardEvent.key`; `at` is a monotonic millisecond clock.
 * Anything that is not a single character or Enter — Tab, Escape, an arrow —
 * abandons the run, because a person reached for it.
 */
export function stepScanBuffer(buffer: ScanBuffer, key: string, at: number): ScanStep {
  if (key === 'Enter') {
    const complete =
      buffer.chars.length >= MIN_CODE_LENGTH && at - buffer.lastAt <= SCAN_GAP_MS
        ? buffer.chars
        : null;
    // The Enter itself is never suppressed here. When it did not close a scan it
    // is somebody submitting the form, and swallowing that is unforgivable.
    return { buffer: EMPTY_SCAN_BUFFER, scanned: complete, suppress: false };
  }

  if (key.length !== 1) return { buffer: EMPTY_SCAN_BUFFER, scanned: null, suppress: false };

  const continues = buffer.chars.length > 0 && at - buffer.lastAt <= SCAN_GAP_MS;
  return {
    buffer: { chars: continues ? buffer.chars + key : key, lastAt: at },
    scanned: null,
    suppress: continues && buffer.chars.length >= SUPPRESS_AFTER,
  };
}

/** SKUs allow these and nothing else — see `skuSchema` in the shared package. */
const SKU_SHAPED = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** EAN-8, UPC-E, UPC-A, EAN-13, GTIN-14 and the ITF-14 sitting on outer cases. */
const GTIN_SHAPED = /^[0-9]{8}$|^[0-9]{12,14}$/;

export interface ScannedCodeFields {
  sku: string;
  barcode: string;
}

/**
 * Which field a code that resolved to nothing should be offered back as.
 *
 * Guessing matters: the create dialog opens with one box already filled, and
 * putting a 13-digit GTIN in the SKU box is how a warehouse ends up with SKUs
 * nobody can read out loud.
 */
export function classifyScannedCode(code: string): ScannedCodeFields {
  const trimmed = code.trim();
  if (GTIN_SHAPED.test(trimmed)) return { sku: '', barcode: trimmed };
  if (SKU_SHAPED.test(trimmed)) return { sku: trimmed.toUpperCase(), barcode: '' };
  // Neither — a Code 128 payload with a slash or a space in it. It cannot be a
  // SKU, so it can only be a barcode.
  return { sku: '', barcode: trimmed };
}
