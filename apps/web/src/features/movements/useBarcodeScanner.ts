import { useEffect, useRef } from 'react';
import { EMPTY_SCAN_BUFFER, stepScanBuffer, type ScanBuffer } from './scanning';

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
 * instinct to "scan into the box" lands. A stray first character in either is
 * cleared by the scan that follows it.
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

      const step = stepScanBuffer(buffer.current, event.key, performance.now());
      buffer.current = step.buffer;

      if (step.scanned !== null) {
        event.preventDefault();
        event.stopPropagation();
        onScanRef.current(step.scanned);
      } else if (step.suppress) {
        event.preventDefault();
      }
    };

    document.addEventListener('keydown', handle, true);
    return () => document.removeEventListener('keydown', handle, true);
  }, [enabled]);
}
