import { Navigate, Outlet, useLocation } from 'react-router';
import { useAuth } from './AuthProvider';

export function ProtectedRoute() {
  const { user, isLoading } = useAuth();
  const location = useLocation();

  // Redirecting before the session probe finishes would bounce a signed-in
  // user to login on every hard refresh.
  if (isLoading) {
    return (
      <div className="flex min-h-svh items-center justify-center">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-muted border-t-primary" />
        <span className="sr-only">Loading</span>
      </div>
    );
  }

  if (!user) {
    // Remember where they were headed so login can send them back there.
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }

  return <Outlet />;
}

/** Keeps an already-signed-in user out of the login and register screens. */
export function PublicOnlyRoute() {
  const { user, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) return null;

  if (user) {
    /*
     * Honour the same `from` the login page uses.
     *
     * The moment login sets the user, this component re-renders and its
     * redirect wins the race against the login page's own navigate() call.
     * Hardcoding /items here therefore silently discarded the destination a
     * bounced user was originally trying to reach, filters and all.
     */
    const from = (location.state as { from?: string } | null)?.from;
    return <Navigate to={from ?? '/items'} replace />;
  }

  return <Outlet />;
}
