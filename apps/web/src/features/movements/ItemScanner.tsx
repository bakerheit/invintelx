import { useMemo, useState } from 'react';
import { Camera, ScanLine } from 'lucide-react';
import { toast } from 'sonner';
import type { Item } from '@invintelx/shared';
import { ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { useItemLookup } from '@/features/items/api';
import { ItemDialog } from '@/features/items/ItemDialog';
import { CameraScanDialog } from './CameraScanDialog';
import { classifyScannedCode } from './scanning';
import { useBarcodeScanner } from './useBarcodeScanner';

/**
 * What a code that did not become an item left behind.
 *
 * Kept on screen until it is dealt with, rather than shown as a toast that
 * fades. The ticket's reasoning is the whole design here: a scan that quietly
 * does nothing is how a pallet goes unrecorded, so the failure has to still be
 * there when somebody looks up from the label.
 */
interface ScanProblem {
  code: string;
  message: string;
  /** Whether creating the item is the way out of this one. */
  offerCreate: boolean;
}

interface ItemScannerProps {
  /**
   * A resolved, movable item. The form is expected to select it and put the
   * cursor in the quantity box — that is the half of the workflow this
   * component cannot do for itself.
   */
  onItem: (item: Item) => void;
  /**
   * A code has been read, before anything is known about it. The form is
   * expected to clear the quantity box here.
   *
   * This cannot wait for `onItem`, because the paths that never reach it are
   * the ones that need it most. `SUPPRESS_AFTER` in scanning.ts lets the first
   * three characters of every code through on purpose, and they land in
   * whatever has focus — which, after the previous scan, is the quantity box.
   * Clear only on success and an unknown `5012345678900` leaves `501` sitting
   * in it: type the real count after that and 12 is posted as 50112, tab away
   * and 501 is posted on its own. A wrong quantity arriving by exactly the
   * route this feature exists to make safe.
   */
  onScanStart: () => void;
}

/**
 * Scanning, wired to one form's item field.
 *
 * Sits above the pickers on every form that writes a quantity. There is nothing
 * to focus and no mode to enter: the listener is live for as long as the form
 * is, because an operator holding a scanner in an aisle should not have to
 * click into a box first.
 */
export function ItemScanner({ onItem, onScanStart }: ItemScannerProps) {
  const lookup = useItemLookup();
  const [problem, setProblem] = useState<ScanProblem | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  const resolve = async (raw: string) => {
    const code = raw.trim();
    if (code === '') return;
    setProblem(null);
    // Before the lookup, so every way this can end has already cleaned up after
    // itself. A scan starts a new line whatever it turns out to resolve to.
    onScanStart();

    try {
      const item = await lookup.mutateAsync(code);

      // Found, but the ledger will not move stock against it. Saying so beats
      // letting them fill the form in and collect a rejection at submit.
      if (item.status === 'archived') {
        const message = `${item.sku} is archived. Restore it from Items before moving stock against it.`;
        setProblem({ code, message, offerCreate: false });
        toast.error(message);
        return;
      }

      onItem(item);
      toast.success(`${item.sku} — ${item.name}`);
    } catch (error) {
      const unknown = error instanceof ApiError && error.status === 404;
      const message = unknown
        ? `Nothing in the catalogue has the SKU or barcode ${code}.`
        : error instanceof ApiError
          ? error.message
          : `Could not look up ${code}.`;
      setProblem({ code, message, offerCreate: unknown });
      toast.error(message);
    }
  };

  // A dialog is somebody typing into a form, and the create dialog in particular
  // is where they type the very code that failed. Listening through either would
  // read that back as a second scan.
  useBarcodeScanner((code) => void resolve(code), !cameraOpen && !createOpen);

  // Stable across renders, so opening the create dialog does not re-seed the
  // form on every keystroke in it.
  const createDefaults = useMemo(
    () => (problem ? classifyScannedCode(problem.code) : undefined),
    [problem],
  );

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-dashed border-border px-3 py-2">
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <ScanLine className="h-4 w-4 shrink-0" />
          {lookup.isPending
            ? 'Looking that code up...'
            : 'Scan a barcode at any time — it picks the item and jumps to the quantity.'}
        </p>
        <Button type="button" variant="outline" size="sm" onClick={() => setCameraOpen(true)}>
          <Camera className="h-4 w-4" />
          Use the camera
        </Button>
      </div>

      {problem && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          <span className="font-medium">{problem.message}</span>
          <span className="ml-auto flex items-center gap-2">
            {problem.offerCreate && (
              <Button type="button" size="sm" onClick={() => setCreateOpen(true)}>
                Create this item
              </Button>
            )}
            <Button type="button" variant="outline" size="sm" onClick={() => setProblem(null)}>
              Dismiss
            </Button>
          </span>
        </div>
      )}

      <CameraScanDialog
        open={cameraOpen}
        onOpenChange={setCameraOpen}
        onScan={(code) => void resolve(code)}
      />

      <ItemDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        defaults={createDefaults}
        onSaved={(created) => {
          // Straight into the form. The reason somebody is in this dialog is
          // that they are holding the thing and want to book it in.
          setProblem(null);
          onItem(created);
          toast.success(`${created.sku} created — carry on`);
        }}
      />
    </div>
  );
}
