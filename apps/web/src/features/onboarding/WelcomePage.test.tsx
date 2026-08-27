import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider } from 'react-router';
import type { OnboardingState } from '@invintelx/shared';
import { AuthProvider } from '@/features/auth/AuthProvider';
import { WelcomePage, headline } from './WelcomePage';

/**
 * The screen a new instance lands on.
 *
 * What is worth pinning is which of the two paths it offers in which state:
 * offering "load the demo dataset" to somebody whose real catalogue is already
 * in there is how invented SKUs end up mixed into real stock, and offering it
 * to a member is a button that can only fail.
 */

function state(overrides: Partial<OnboardingState> = {}): OnboardingState {
  return {
    items: 0,
    locations: 0,
    movements: 0,
    empty: true,
    demo: null,
    canManageDemo: true,
    ...overrides,
  };
}

interface Call {
  url: string;
  method: string;
}

const SIGNED_IN = {
  id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
  email: 'ada@invintelx.org',
  name: 'Ada Operator',
  role: 'admin',
  createdAt: '2026-08-26T09:00:00.000Z',
};

/** Answers /onboarding with the given state, and records what else was asked. */
function stubApi(onboarding: OnboardingState, calls: Call[] = []) {
  vi.stubGlobal('fetch', (input: string, init?: { method?: string }) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET' });

    const body = url.endsWith('/auth/me')
      ? { user: SIGNED_IN }
      : url.endsWith('/onboarding')
        ? onboarding
        : // Whatever a load or a wipe returned; both are counts.
          { items: 40, locations: 7, suppliers: 5, supplierItems: 100, movements: 1200 };

    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });
  return calls;
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const router = createMemoryRouter(
    [
      { path: '/welcome', element: <WelcomePage /> },
      { path: '/dashboard', element: <p>the dashboard</p> },
      { path: '/items', element: <p>the item table</p> },
    ],
    { initialEntries: ['/welcome'] },
  );
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('headline', () => {
  it('says the instance is empty when it is', () => {
    expect(headline(state())).toMatch(/nothing in this instance yet/i);
  });

  it('points at the banner once the demo is loaded, rather than offering it again', () => {
    expect(headline(state({ empty: false, demo: demoState() }))).toMatch(/demo dataset is loaded/i);
  });

  it('says there is nothing to do on an instance that already has data', () => {
    const sentence = headline(state({ empty: false, items: 4000 }));
    expect(sentence).toMatch(/4,000 items/);
    expect(sentence).not.toMatch(/demo/i);
  });

  it('claims nothing until the instance has answered', () => {
    expect(headline(undefined)).toMatch(/working out/i);
  });
});

function demoState() {
  return {
    items: 40,
    locations: 7,
    suppliers: 5,
    supplierItems: 100,
    movements: 1200,
    loadedAt: '2026-08-26T09:00:00.000Z',
    loadedBy: 'Ada Operator',
  };
}

describe('WelcomePage', () => {
  it('offers both paths that exist on an empty instance', async () => {
    stubApi(state());
    renderPage();

    expect(await screen.findByRole('button', { name: /import csv/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /load demo data/i })).toBeInTheDocument();
  });

  it('loads the demo dataset and ends on the dashboard', async () => {
    const calls = stubApi(state());
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: /load demo data/i }));

    expect(await screen.findByText('the dashboard')).toBeInTheDocument();
    expect(calls).toContainEqual({ url: '/api/onboarding/demo', method: 'POST' });
  });

  it('will not offer the demo to an instance that already has data of its own', async () => {
    stubApi(state({ empty: false, items: 12 }));
    renderPage();

    expect(await screen.findByText(/very hard to unpick/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /load demo data/i })).not.toBeInTheDocument();
  });

  it('tells a member who to ask instead of showing a button that would be refused', async () => {
    stubApi(state({ canManageDemo: false }));
    renderPage();

    expect(await screen.findByText(/takes an administrator/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /load demo data/i })).not.toBeInTheDocument();
  });

  it('sends somebody already looking at the demo on to the dashboard', async () => {
    stubApi(state({ empty: false, items: 40, demo: demoState() }));
    renderPage();

    expect(await screen.findByRole('link', { name: /go to the dashboard/i })).toBeInTheDocument();
  });
});
