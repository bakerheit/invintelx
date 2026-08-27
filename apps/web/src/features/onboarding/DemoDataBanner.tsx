import { useState } from 'react';
import { useNavigate } from 'react-router';
import { FlaskConical } from 'lucide-react';
import { toast } from 'sonner';
import type { DemoDataState, DemoRemovalResult } from '@invintelx/shared';
import { ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { formatMovementDate } from '@/lib/dates';
import { useOnboarding, useRemoveDemoData } from './api';

/**
 * The demo dataset, said out loud on every screen it is affecting.
 *
 * Demo data that is not obviously demo is worse than no demo data at all: every
 * number on the dashboard is invented, and somebody will otherwise quote one in
 * a meeting. So this sits above the content rather than tucked into a corner,
 * and it stays there for as long as the data does.
 *
 * It renders nothing at all on an instance that never loaded it, which is every
 * instance running on real stock.
 */
export function DemoDataBanner() {
  const state = useOnboarding();
  const remove = useRemoveDemoData();
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);

  const demo = state.data?.demo;
  if (!demo) return null;

  const confirmRemove = () => {
    setConfirming(false);
    remove.mutate(undefined, {
      onSuccess: (result) => {
        toast.success(
          `Demo data removed: ${result.items} items and ${result.movements.toLocaleString()} movements.`,
          { description: retentionSentence(result) },
        );
        // Straight back to the one screen that has something to say about an
        // empty instance, rather than to whichever list just went blank.
        navigate('/welcome');
      },
      onError: (error) =>
        toast.error(
          error instanceof ApiError ? error.message : 'Could not remove the demo data.',
        ),
    });
  };

  return (
    <div className="border-b border-warning/30 bg-warning/10">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 sm:px-6">
        <FlaskConical className="h-4 w-4 shrink-0 text-warning" aria-hidden />
        <p className="min-w-[240px] flex-1 text-sm">
          <span className="font-medium">Demo data.</span>{' '}
          <span className="text-muted-foreground">{demoSentence(demo)}</span>
        </p>

        {state.data?.canManageDemo ? (
          <Button
            variant="outline"
            size="sm"
            disabled={remove.isPending}
            onClick={() => setConfirming(true)}
          >
            {remove.isPending ? 'Removing...' : 'Remove demo data'}
          </Button>
        ) : (
          <p className="text-xs text-muted-foreground">
            An administrator can remove it.
          </p>
        )}
      </div>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove the demo data?</AlertDialogTitle>
            <AlertDialogDescription>
              {/* Named precisely, because "remove demo data" on an instance
                  that has since had real work done in it must not read as
                  "delete everything". */}
              This deletes the {demo.items} demo{' '}
              {demo.items === 1 ? 'item' : 'items'}, their{' '}
              {demo.locations} {demo.locations === 1 ? 'location' : 'locations'} and{' '}
              {demo.suppliers} {demo.suppliers === 1 ? 'supplier' : 'suppliers'}, and every
              movement against them — {demo.movements.toLocaleString()} in all. Anything you
              created yourself stays, including any demo location or supplier your own stock is
              already using. It cannot be undone, but the demo can be loaded again from the
              welcome screen.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmRemove}>Remove demo data</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/**
 * The part of a wipe nobody asked for but everybody needs told: which demo
 * locations and suppliers were kept because the user's own stock had come to
 * rest in them. Undefined when nothing was kept, which is the ordinary case —
 * a toast should not carry a line saying that nothing happened.
 */
export function retentionSentence(result: DemoRemovalResult): string | undefined {
  const kept = [
    result.retainedLocations > 0 &&
      `${result.retainedLocations} ${result.retainedLocations === 1 ? 'location' : 'locations'}`,
    result.retainedSuppliers > 0 &&
      `${result.retainedSuppliers} ${result.retainedSuppliers === 1 ? 'supplier' : 'suppliers'}`,
  ].filter((part): part is string => typeof part === 'string');

  if (kept.length === 0) return undefined;
  return `${kept.join(' and ')} stayed: your own data is using them, so they are yours now.`;
}

/** What is on screen and where it came from, in one sentence. */
export function demoSentence(demo: DemoDataState): string {
  return (
    `Every figure on these screens is invented — ${demo.items.toLocaleString()} ` +
    `made-up ${demo.items === 1 ? 'SKU' : 'SKUs'} and ` +
    `${demo.movements.toLocaleString()} ${demo.movements === 1 ? 'movement' : 'movements'}, ` +
    `loaded by ${demo.loadedBy} on ${formatMovementDate(demo.loadedAt)}.`
  );
}
