import { useEffect, useRef } from 'react';
import { EMPTY_SCAN_BUFFER, isModifierKey, stepScanBuffer, type ScanBuffer } from './scanning';

/**
 * Where a scan is allowed to interrupt.
 *
 * The listener sits on the document, so it hears everything — including
 * somebody typing a delivery note number into Reference. Free text is theirs:
 * a scan is not worth eating a sentence somebody was halfway through.
 *
 * The two inputs that *are* armed are the ones an operator is realistically
 * standing on when the next label goes under the gun — the quantity box, which
 * the previous scan put them in, and the item search, which is where the
 * instinct to "scan into the box" lands.
 *
 * A stray first character in the quantity box is cleared by the scan that
 * follows it: every form empties that box from `onScanStart`. The item search is
 * not cleared by anything — the forms call `onChange` directly rather than
 * SearchPicker's own `choose`, so its query keeps whatever `SUPPRESS_AFTER` let
 * through. That is visible residue and not a wrong value: a chosen item swaps
 * the search box out for the chosen-row view, and an Enter on a run too short to
 * be a code is held back before the picker can read it.
 */
export function isScanTarget(element: Element | null): boolean {
  if (!element) return true;

  const tag = element.tagName;
  if (tag === 'INPUT') {
    const input = element as HTMLInputElement;
    return input.type === 'number' || input.getAttribute('role') === 'combobox';
  }
  if (tag === 'TEXTAREA') return false;
  return !(element as HTMLElement).isContentEditable;
}

/**
 * Fire `onScan` when a keyboard-wedge scanner types a code and sends Enter.
 *
 * Listens in the capture phase on the document, so a scan is caught before the
 * Enter reaches a picker that would read it as "take the highlighted option" or
 * a form that would read it as "submit".
 */
export function useBarcodeScanner(onScan: (code: string) => void, enabled = true): void {
  const buffer = useRef<ScanBuffer>(EMPTY_SCAN_BUFFER);
  // Held in a ref so a handler that closes over fresh state does not tear the
  // listener down and back up on every render — and lose the buffer with it.
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;

  useEffect(() => {
    if (!enabled) {
      buffer.current = EMPTY_SCAN_BUFFER;
      return;
    }

    const handle = (event: KeyboardEvent) => {
      /*
       * A modifier pressed on its own is skipped before anything else looks at
       * it. It is how uppercase arrives from a wedge scanner, so none of the
       * rules below may fire on it: the chord test would see `altKey` on an
       * AltGraph keydown, and the buffer would be abandoned mid-code. Left
       * entirely alone, the run continues into the character it is modifying.
       */
      if (isModifierKey(event.key)) return;

      // Auto-repeat arrives at scanner speed, and a chord is somebody reaching
      // for a shortcut. Neither is a label going under the gun.
      if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) {
        buffer.current = EMPTY_SCAN_BUFFER;
        return;
      }
      if (!isScanTarget(document.activeElement)) {
        buffer.current = EMPTY_SCAN_BUFFER;
        return;
      }

      /*
       * The event's own timestamp, not the clock read here. Both sit on the
       * same time origin, but `performance.now()` in a listener says when the
       * handler got the thread — and the gap that decides this is 35ms, which
       * an ordinary React render can swallow whole. The item search is armed as
       * a scan target on purpose, and each unsuppressed character there costs a
       * render; on a warehouse tablet three of those are enough to make a
       * scanner look like a person and abandon the code halfway through.
       * `event.timeStamp` is stamped by the UA when the keystroke happened and
       * does not care what the page was busy with afterwards.
       */
      const step = stepScanBuffer(buffer.current, event.key, event.timeStamp);
      buffer.current = step.buffer;

      if (step.scanned !== null) {
        event.preventDefault();
        event.stopPropagation();
        onScanRef.current(step.scanned);
      } else if (step.suppress) {
        event.preventDefault();
        /*
         * A held-back Enter has to be kept from handlers as well as from the
         * field. `preventDefault` stops the implicit form submit, but the item
         * picker reads Enter in its own `onKeyDown` and takes the highlighted
         * row — a partial match for the characters this same run leaked into the
         * search box. Nothing else in these forms acts on a bare character
         * keydown, so this stays on the key that needs it.
         */
        if (event.key === 'Enter') event.stopPropagation();
      }
    };

    document.addEventListener('keydown', handle, true);
    return () => document.removeEventListener('keydown', handle, true);
  }, [enabled]);
}
