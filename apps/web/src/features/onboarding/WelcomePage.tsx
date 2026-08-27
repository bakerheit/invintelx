import { useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { ArrowRight, FlaskConical, Upload } from 'lucide-react';
import { toast } from 'sonner';
import type { OnboardingState } from '@invintelx/shared';
import { ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/features/auth/AuthProvider';
import { ImportDialog } from '@/features/items/ImportDialog';
import { useLoadDemoData, useOnboarding } from './api';

/**
 * The first five minutes.
 *
 * A fresh instance has no items, no locations and no movements, so the
 * dashboard, the action list and the item table are all empty at once. Three
 * empty screens is not an onboarding — this is the one screen that says what to
 * do about it, and every empty state elsewhere points here rather than
 * apologising on its own.
 *
 * Only two paths are offered because only two exist: bring a CSV, or load the
 * demo dataset and look around. Creating one SKU by hand is a third thing you
 * can do, but it is not a way to get to a useful screen, so it is a footnote
 * rather than a card.
 */
export function WelcomePage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const state = useOnboarding();
  const loadDemo = useLoadDemoData();
  const [importOpen, setImportOpen] = useState(false);

  const runLoadDemo = () => {
    loadDemo.mutate(undefined, {
      onSuccess: (result) => {
        toast.success(
          `Demo data loaded: ${result.items} items and ${result.movements.toLocaleString()} movements.`,
        );
        // Ends somewhere useful. The dashboard is the point of the demo — it is
        // the only screen that has anything to say about four months of trading.
        navigate('/dashboard');
      },
      onError: (error) =>
        toast.error(
          error instanceof ApiError ? error.message : 'Could not load the demo dataset.',
        ),
    });
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Welcome{user ? `, ${user.name.split(' ')[0]}` : ''}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">{headline(state.data)}</p>
      </div>

      {state.isLoading && (
        <div className="space-y-3">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      )}

      {state.error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-6">
          <p className="font-medium text-destructive">Could not read the state of this instance</p>
          <p className="mt-1 text-sm text-muted-foreground">{state.error.message}</p>
        </div>
      )}

      {state.data && (
        <>
          <Choice
            icon={Upload}
            title="Import your items from a CSV"
            body="Bring the catalogue you already have. Columns are mapped by hand if the names do not match, nothing is written until you have seen what the file would do, and rows are matched on SKU — so importing a corrected file later updates your items rather than duplicating them."
          >
            <Button onClick={() => setImportOpen(true)}>
              <Upload /> Import CSV
            </Button>
          </Choice>

          <Choice
            icon={FlaskConical}
            title="Load the demo dataset and look around"
            body="Forty SKUs of a builders' merchant with four months of trading behind them: stock that has run out, stock that is about to, and stock that has not moved since spring. Enough for the dashboard to have something to rank. Every row it creates is labelled demo, and it all comes out again in one press."
          >
            {demoAction(state.data, {
              onLoad: runLoadDemo,
              isLoading: loadDemo.isPending,
            })}
          </Choice>

          <p className="text-sm text-muted-foreground">
            Or start from nothing:{' '}
            <Link to="/items" className="font-medium text-primary hover:underline">
              add one item by hand
            </Link>
            . The dashboard stays quiet until something has moved.
          </p>
        </>
      )}

      <ImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        // An import is only over when there are rows to look at, so this is
        // where the first five minutes ends for anyone who brought a file.
        onImported={() => navigate('/items')}
      />
    </div>
  );
}

/**
 * One sentence about where this instance actually is, because the three cases
 * want three different things said and a generic greeting says none of them.
 */
export function headline(state: OnboardingState | undefined): string {
  if (!state) return 'Working out what is in this instance...';
  if (state.demo) {
    return 'The demo dataset is loaded. Have a look around, and remove it from the banner above when you are ready for your own data.';
  }
  if (!state.empty) {
    return `This instance already has ${state.items.toLocaleString()} ${
      state.items === 1 ? 'item' : 'items'
    } in it. Nothing here needs doing.`;
  }
  return 'There is nothing in this instance yet, so every screen has nothing to draw. Two ways to change that, and both take about a minute.';
}

function demoAction(
  state: OnboardingState,
  handlers: { onLoad: () => void; isLoading: boolean },
): ReactNode {
  if (state.demo) {
    return (
      <Button asChild variant="outline">
        <Link to="/dashboard">
          Go to the dashboard <ArrowRight />
        </Link>
      </Button>
    );
  }

  // Refused by the server too — this only saves somebody the round trip and
  // says why, which a disabled button on its own would not.
  if (!state.empty) {
    return (
      <p className="text-sm text-muted-foreground">
        Not offered once an instance has data of its own: made-up SKUs mixed into
        a real catalogue would be very hard to unpick later.
      </p>
    );
  }

  if (!state.canManageDemo) {
    return (
      <p className="text-sm text-muted-foreground">
        Loading it changes the whole catalogue, so it takes an administrator. Ask
        whoever set this instance up.
      </p>
    );
  }

  return (
    <Button variant="outline" onClick={handlers.onLoad} disabled={handlers.isLoading}>
      <FlaskConical /> {handlers.isLoading ? 'Loading demo data...' : 'Load demo data'}
    </Button>
  );
}

function Choice({
  icon: Icon,
  title,
  body,
  children,
}: {
  icon: typeof Upload;
  title: string;
  body: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border bg-card p-6">
      <h2 className="flex items-center gap-2 font-medium">
        <Icon className="h-4 w-4 text-primary" aria-hidden />
        {title}
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">{body}</p>
      <div className="mt-4">{children}</div>
    </section>
  );
}
