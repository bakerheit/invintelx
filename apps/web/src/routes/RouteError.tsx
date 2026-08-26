import { isRouteErrorResponse, Link, useRouteError } from 'react-router';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api';

/**
 * Mounted on both layout roots. Without it, anything thrown inside a route
 * renders a blank white page with the real error only in the console — the user
 * sees nothing and reports nothing useful.
 */
export function RouteError() {
  const error = useRouteError();
  const { title, detail } = describe(error);

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
