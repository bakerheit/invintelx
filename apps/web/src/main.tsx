import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router';
import { Toaster } from 'sonner';
import { ThemeProvider, useTheme } from '@/components/ThemeProvider';
import { AuthProvider } from '@/features/auth/AuthProvider';
import { installGlobalErrorReporting } from '@/lib/errorReporting';
import { queryClient } from '@/lib/queryClient';
import { router } from '@/routes/router';
import './index.css';

/** sonner needs to be told the theme; it does not read the `dark` class. */
function ThemedToaster() {
  const { resolved } = useTheme();
  return <Toaster theme={resolved} position="bottom-right" richColors closeButton />;
}

/*
 * Before the first render, so an error thrown while the app is mounting is
 * still caught. Never uninstalled - it lives as long as the page does.
 */
installGlobalErrorReporting();

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Missing #root element');

createRoot(rootElement).render(
  <StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <RouterProvider router={router} />
          <ThemedToaster />
        </AuthProvider>
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);
