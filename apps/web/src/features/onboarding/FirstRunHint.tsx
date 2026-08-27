import { Link } from 'react-router';
import { ArrowRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useOnboarding } from './api';

/**
 * The one line every empty screen shares.
 *
 * The dashboard, the item table and the movement ledger are all empty for the
 * same reason on a new instance, and each of them apologising in its own words
 * leaves a reader three dead ends and no next step. This is the next step, and
 * it is the same next step on all three.
 *
 * It renders nothing once the instance has anything in it: an item table that
 * is empty because of a filter is not a first run, and telling somebody with
 * four thousand SKUs to go and load the demo data would be nonsense.
 */
export function FirstRunHint({ className }: { className?: string }) {
  const state = useOnboarding();
  if (!state.data?.empty) return null;

  return (
    <p className={cn('text-sm text-muted-foreground', className)}>
      Nothing is in this instance yet.{' '}
      <Link
        to="/welcome"
        className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
      >
        Import a CSV or load the demo data
        <ArrowRight className="h-3.5 w-3.5" aria-hidden />
      </Link>
    </p>
  );
}
