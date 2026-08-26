import { createBrowserRouter, Navigate } from 'react-router';
import { AppShell } from '@/components/AppShell';
import { ProtectedRoute, PublicOnlyRoute } from '@/features/auth/ProtectedRoute';
import { LoginPage } from '@/features/auth/LoginPage';
import { RegisterPage } from '@/features/auth/RegisterPage';
import { ItemsPage } from '@/features/items/ItemsPage';
import { NotFoundPage } from './NotFoundPage';

export const router = createBrowserRouter([
  {
    element: <PublicOnlyRoute />,
    children: [
      { path: '/login', element: <LoginPage /> },
      { path: '/register', element: <RegisterPage /> },
    ],
  },
  {
    element: <ProtectedRoute />,
    children: [
      {
        element: <AppShell />,
        children: [
          // Items is the only built screen, so it is the landing page until the
          // dashboard epic lands.
          { path: '/', element: <Navigate to="/items" replace /> },
          { path: '/items', element: <ItemsPage /> },
        ],
      },
    ],
  },
  { path: '*', element: <NotFoundPage /> },
]);
