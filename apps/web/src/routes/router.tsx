import { Suspense, lazy, type ReactElement } from 'react';
import { createBrowserRouter, Navigate } from 'react-router';
import { AppShell } from '@/components/AppShell';
import { ProtectedRoute, PublicOnlyRoute } from '@/features/auth/ProtectedRoute';
import { LoginPage } from '@/features/auth/LoginPage';
import { RegisterPage } from '@/features/auth/RegisterPage';
import { ItemsPage } from '@/features/items/ItemsPage';
import { ItemDetailPage } from '@/features/items/ItemDetailPage';
import { MovementsPage } from '@/features/movements/MovementsPage';
import { DashboardPage } from '@/features/dashboard/DashboardPage';
import { NotFoundPage } from './NotFoundPage';
import { RouteError } from './RouteError';
import { RouteFallback } from './RouteFallback';

/*
 * The counting screens are behind a dynamic import. They are the two heaviest
 * pages in the app and the two fewest people open — a sheet is cut once a week
 * and read by whoever is holding the scanner — so putting them in the chunk
 * every visitor downloads would charge the login screen for them.
 */
const CountsPage = lazy(() =>
  import('@/features/counts/CountsPage').then((m) => ({ default: m.CountsPage })),
);
const CountSheetPage = lazy(() =>
  import('@/features/counts/CountSheetPage').then((m) => ({ default: m.CountSheetPage })),
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
      { path: '/login', element: <LoginPage /> },
      { path: '/register', element: <RegisterPage /> },
    ],
  },
  {
    element: <ProtectedRoute />,
    errorElement: <RouteError />,
    children: [
      {
        element: <AppShell />,
        children: [
          { path: '/', element: <Navigate to="/dashboard" replace /> },
          { path: '/dashboard', element: <DashboardPage /> },
          { path: '/items', element: <ItemsPage /> },
          { path: '/items/:id', element: <ItemDetailPage /> },
          { path: '/movements', element: <MovementsPage /> },
          { path: '/counts', element: suspended(<CountsPage />) },
          { path: '/counts/:id', element: suspended(<CountSheetPage />) },
        ],
      },
    ],
  },
  { path: '*', element: <NotFoundPage /> },
]);
