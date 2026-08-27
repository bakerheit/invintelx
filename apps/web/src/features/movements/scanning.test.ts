import { describe, expect, it } from 'vitest';
import {
  classifyScannedCode,
  EMPTY_SCAN_BUFFER,
  stepScanBuffer,
  type ScanBuffer,
} from './scanning';

/**
 * Drive a whole run through the buffer at a fixed gap and report what fell out.
 *
 * `gap` is the milliseconds between keystrokes — the only thing that separates a
 * scanner from a person, and therefore the only variable these tests move.
 */
function run(keys: string[], gap: number, from: ScanBuffer = EMPTY_SCAN_BUFFER, startAt = 1_000) {
  let buffer = from;
  let at = startAt;
  const scanned: string[] = [];
  const suppressed: string[] = [];

  for (const key of keys) {
    at += gap;
    const step = stepScanBuffer(buffer, key, at);
    buffer = step.buffer;
    if (step.scanned !== null) scanned.push(step.scanned);
    if (step.suppress) suppressed.push(key);
  }

  return { buffer, scanned, suppressed };
}

const GTIN = '5012345678900'.split('');

describe('telling a scanner from a person', () => {
  it('reads a code typed at scanner speed and terminated by Enter', () => {
    expect(run([...GTIN, 'Enter'], 8).scanned).toEqual(['5012345678900']);
  });

  /*
   * The failure that matters most. A person filling in a reference by hand must
   * never have it swallowed and posted as a scan.
   */
  it('ignores the same code typed by a person', () => {
    expect(run([...GTIN, 'Enter'], 120).scanned).toEqual([]);
  });

  /*
   * The realistic sequence: somebody types a couple of characters somewhere,
   * gives up, and puts a label under the gun. What the scanner sends has to
   * arrive whole, with none of their typing glued to the front of it.
   */
  it('reads a scan cleanly after somebody has been typing slowly', () => {
    const slow = run(['A', 'B'], 400);
    expect(slow.scanned).toEqual([]);

    // A second later, which is a person putting a pen down and picking a gun up.
    const fast = run([...GTIN, 'Enter'], 8, slow.buffer, slow.buffer.lastAt + 1_000);
    expect(fast.scanned).toEqual(['5012345678900']);
  });

  it('does not call three characters and an Enter a scan', () => {
    expect(run(['A', 'B', 'C', 'Enter'], 8).scanned).toEqual([]);
  });

  it('lets a bare Enter through as a form submit', () => {
    const step = stepScanBuffer(EMPTY_SCAN_BUFFER, 'Enter', 1_000);
    expect(step.scanned).toBeNull();
    expect(step.suppress).toBe(false);
  });

  /*
   * An Enter that closed nothing is somebody submitting the form. Suppressing it
   * would make the submit button the only way to post a movement.
   */
  it('never suppresses an Enter that did not close a scan', () => {
    expect(run(['A', 'B', 'Enter'], 8).suppressed).toEqual([]);
  });

  it('abandons the run when a person reaches for a key that is not a character', () => {
    expect(run(['B', 'O', 'L', 'Tab', 'T', 'Enter'], 8).scanned).toEqual([]);
  });

  /*
   * Uppercase off a wedge scanner is a Shift keydown of its own, which arrives
   * in the middle of the code. Treating it as "somebody reached for a key" reads
   * BOLT-M6-30 as M6-30 — a code that resolves to nothing and offers to create
   * an item already in the catalogue. Every fixture in this file was numeric,
   * which is why the buffer could get this wrong and stay green.
   */
  it('reads a code whose uppercase letters arrive behind their own Shift keydown', () => {
    const wedge = ['Shift', 'B', 'O', 'L', 'T', '-', 'Shift', 'M', '6', '-', '3', '0'];
    expect(run([...wedge, 'Enter'], 8).scanned).toEqual(['BOLT-M6-30']);
  });

  /*
   * The worse half, and the one the ticket is about. A code ending in uppercase
   * leaves a tail shorter than MIN_CODE_LENGTH once the last Shift has wiped the
   * buffer, so the scan does not fail — it does nothing at all, and a pallet
   * goes unrecorded.
   */
  it('reads a code that ends in an uppercase run rather than silently dropping it', () => {
    const wedge = ['Shift', 'A', 'B', 'C', '-', '1', '2', '3', '-', 'Shift', 'X', 'Y'];
    expect(run([...wedge, 'Enter'], 8).scanned).toEqual(['ABC-123-XY']);
  });

  /** Scanners configured for CapsLock mode send that instead, and it is the same bug. */
  it('reads a code from a scanner that toggles CapsLock instead of holding Shift', () => {
    const wedge = ['CapsLock', 'B', 'O', 'L', 'T', 'CapsLock', '-', '1', '2', '3', '4'];
    expect(run([...wedge, 'Enter'], 8).scanned).toEqual(['BOLT-1234']);
  });

  /*
   * A modifier is not a keystroke in the run: it neither extends the buffer nor
   * charges it for the time it was held. The gap that decides this is between
   * characters.
   */
  it('leaves the buffer and its clock untouched when a modifier goes down', () => {
    const started = run(['B', 'O', 'L', 'T'], 8);
    const step = stepScanBuffer(started.buffer, 'Shift', started.buffer.lastAt + 200);

    expect(step.buffer).toBe(started.buffer);
    expect(step.scanned).toBeNull();
    expect(step.suppress).toBe(false);
  });

  /*
   * The other direction, so the modifier exemption does not become a way to hold
   * a run open forever: what happens after it is still timed from the last real
   * character, and a person is still a person.
   */
  it('does not let a modifier rescue a run somebody was typing by hand', () => {
    const keys = ['B', 'O', 'L', 'Shift', 'T', 'Shift', 'M', 'Enter'];
    expect(run(keys, 120).scanned).toEqual([]);
  });

  /*
   * The first three characters still reach whatever has focus, on purpose: a
   * dropped keystroke is worse than a stray one, and the scan clears the box it
   * landed in. From the fourth, nobody is typing.
   */
  it('lets three characters through and holds the rest back', () => {
    const { suppressed } = run([...GTIN, 'Enter'], 8);
    expect(suppressed).toEqual(GTIN.slice(3));
  });

  it('holds nothing back from somebody typing a quantity quickly', () => {
    expect(run(['3', '0'], 8).suppressed).toEqual([]);
  });
});

describe('offering an unrecognised code back as a field', () => {
  it('treats a 13-digit code as a barcode, not a SKU', () => {
    expect(classifyScannedCode('5012345678900')).toEqual({ sku: '', barcode: '5012345678900' });
  });

  it('treats a code shaped like a SKU as one, uppercased the way the API stores it', () => {
    expect(classifyScannedCode('bolt-m6-30')).toEqual({ sku: 'BOLT-M6-30', barcode: '' });
  });

  it('offers a code no SKU could ever be as a barcode', () => {
    expect(classifyScannedCode('LOT/2026 A')).toEqual({ sku: '', barcode: 'LOT/2026 A' });
  });

  it('does not put a short numeric code in the SKU box either way round', () => {
    expect(classifyScannedCode('12345678').barcode).toBe('12345678');
  });
});
