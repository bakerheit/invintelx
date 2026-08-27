import { useEffect } from 'react';
import { isRouteErrorResponse, Link, useRouteError } from 'react-router';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api';
import { reportClientError } from '@/lib/errorReporting';

/**
 * Mounted on both layout roots. Without it, anything thrown inside a route
 * renders a blank white page with the real error only in the console — the user
 * sees nothing and reports nothing useful.
 */
export function RouteError() {
  const error = useRouteError();
  const { title, detail } = describe(error);

  /*
   * The user has now seen a broken screen; this is what makes sure somebody
   * operating the instance sees it too. In an effect rather than in `describe`
   * because rendering must stay a pure function of the error — React renders a
   * boundary twice in StrictMode, and a network call in the render path would
   * fire twice for one failure.
   */
  useEffect(() => {
    if (!isReportable(error)) return;
    reportClientError(error, {
      kind: 'render',
      ...(error instanceof ApiError && error.requestId ? { requestId: error.requestId } : {}),
    });
  }, [error]);

  return (
    <div className="flex min-h-svh items-center justify-center px-4 py-12">
      <div className="w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-sm">
        <div className="flex items-center gap-2 text-destructive">
          <AlertTriangle className="h-5 w-5" />
          <h1 className="font-semibold">{title}</h1>
        </div>

        <p className="mt-2 break-words text-sm text-muted-foreground">{detail}</p>

        <div className="mt-6 flex gap-2">
          <Button asChild>
            <Link to="/items">Back to items</Link>
          </Button>
          <Button variant="outline" onClick={() => window.location.reload()}>
            Reload
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Which of these are worth a server-side log line.
 *
 * A 404 from a loader and a 401 on a dead session are the app working: the
 * boundary rendered because that is how the router reports them, not because
 * anything broke. Reporting them would bury the crashes in noise, which is how
 * an error tracker becomes something nobody reads.
 */
function isReportable(error: unknown): boolean {
  if (isRouteErrorResponse(error)) return error.status >= 500;
  if (error instanceof ApiError) return error.status >= 500;
  return true;
}

function describe(error: unknown): { title: string; detail: string } {
  // A response thrown by the router — a 404 from a loader, say.
  if (isRouteErrorResponse(error)) {
    return {
      title: `${String(error.status)} ${error.statusText}`,
      detail: typeof error.data === 'string' && error.data ? error.data : 'That request could not be completed.',
    };
  }

  // Our own API failures already carry a human-readable message.
  if (error instanceof ApiError) {
    return { title: 'Something went wrong', detail: error.message };
  }

  if (error instanceof Error) {
    return { title: 'Something broke', detail: error.message };
  }

  return { title: 'Something broke', detail: 'An unexpected error occurred.' };
}
