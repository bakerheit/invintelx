import { Suspense, lazy, type ReactElement } from 'react';
import { createBrowserRouter, Navigate } from 'react-router';
import { ProtectedRoute, PublicOnlyRoute } from '@/features/auth/ProtectedRoute';
import { NotFoundPage } from './NotFoundPage';
import { RouteError } from './RouteError';
import { RouteFallback } from './RouteFallback';

/*
 * Every screen is behind a dynamic import, so the entry chunk carries the
 * router, the session probe and the shell of a page and nothing else. A
 * signed-out visitor on a warehouse tablet downloads the login screen; the
 * items table, the movement forms and the audit trail stay on the server until
 * somebody navigates to them.
 *
 * The shell is split too. It is only ever rendered behind ProtectedRoute, so
 * pulling its command palette and dropdown menus into the first paint of a
 * login screen would be paying for a screen the visitor cannot reach.
 *
 * `RouteError` and `NotFoundPage` are deliberately not split: they are what
 * renders when something has already gone wrong, and a failed chunk fetch is
 * one of the things that goes wrong.
 */
const AppShell = lazy(() =>
  import('@/components/AppShell').then((m) => ({ default: m.AppShell })),
);
const LoginPage = lazy(() =>
  import('@/features/auth/LoginPage').then((m) => ({ default: m.LoginPage })),
);
const RegisterPage = lazy(() =>
  import('@/features/auth/RegisterPage').then((m) => ({ default: m.RegisterPage })),
);
const DashboardPage = lazy(() =>
  import('@/features/dashboard/DashboardPage').then((m) => ({ default: m.DashboardPage })),
);
const ItemsPage = lazy(() =>
  import('@/features/items/ItemsPage').then((m) => ({ default: m.ItemsPage })),
);
const ItemDetailPage = lazy(() =>
  import('@/features/items/ItemDetailPage').then((m) => ({ default: m.ItemDetailPage })),
);
const MovementsPage = lazy(() =>
  import('@/features/movements/MovementsPage').then((m) => ({ default: m.MovementsPage })),
);
const AuditPage = lazy(() =>
  import('@/features/audit/AuditPage').then((m) => ({ default: m.AuditPage })),
);

/**
 * A boundary per screen rather than one around the whole tree: inside the
 * shell only `<main>` is replaced while the next chunk arrives, so the sidebar
 * and header do not flicker on every navigation.
 */
function suspended(element: ReactElement): ReactElement {
  return <Suspense fallback={<RouteFallback />}>{element}</Suspense>;
}

export const router = createBrowserRouter([
  {
    element: <PublicOnlyRoute />,
    // Every branch gets a boundary. A throw with no errorElement above it
    // unmounts the whole tree and paints nothing.
    errorElement: <RouteError />,
    children: [
      { path: '/login', element: suspended(<LoginPage />) },
      { path: '/register', element: suspended(<RegisterPage />) },
    ],
  },
  {
    element: <ProtectedRoute />,
    errorElement: <RouteError />,
    children: [
      {
        element: suspended(<AppShell />),
        children: [
          { path: '/', element: <Navigate to="/dashboard" replace /> },
          { path: '/dashboard', element: suspended(<DashboardPage />) },
          { path: '/items', element: suspended(<ItemsPage />) },
          { path: '/items/:id', element: suspended(<ItemDetailPage />) },
          { path: '/movements', element: suspended(<MovementsPage />) },
          // Admin-gated inside the page rather than by a route wrapper, so a
          // member following a link is told why instead of being bounced.
          { path: '/audit', element: suspended(<AuditPage />) },
        ],
      },
    ],
  },
  { path: '*', element: <NotFoundPage /> },
]);
