import { createBrowserRouter, Navigate } from 'react-router';
import { AppShell } from '@/components/AppShell';
import { ProtectedRoute, PublicOnlyRoute } from '@/features/auth/ProtectedRoute';
import { LoginPage } from '@/features/auth/LoginPage';
import { RegisterPage } from '@/features/auth/RegisterPage';
import { ItemsPage } from '@/features/items/ItemsPage';
import { ItemDetailPage } from '@/features/items/ItemDetailPage';
import { DashboardPage } from '@/features/dashboard/DashboardPage';
import { NotFoundPage } from './NotFoundPage';
import { RouteError } from './RouteError';

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
        ],
      },
    ],
  },
  { path: '*', element: <NotFoundPage /> },
]);
