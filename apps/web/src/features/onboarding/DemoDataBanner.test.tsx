import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider } from 'react-router';
import type { DemoDataState, OnboardingState } from '@invintelx/shared';
import { DemoDataBanner, demoSentence } from './DemoDataBanner';

/**
 * Demo data that is not obviously demo is worse than no demo data at all —
 * every figure on the dashboard is invented, and somebody will quote one. These
 * pin that the banner is there whenever the data is, that it says so in words
 * rather than by implication, and that removing it is one press away.
 */

const DEMO: DemoDataState = {
  items: 40,
  locations: 7,
  suppliers: 5,
  supplierItems: 100,
  movements: 1204,
  loadedAt: '2026-08-26T09:00:00.000Z',
  loadedBy: 'Ada Operator',
};

function state(overrides: Partial<OnboardingState> = {}): OnboardingState {
  return {
    items: 40,
    locations: 7,
    movements: 1204,
    empty: false,
    demo: DEMO,
    canManageDemo: true,
    ...overrides,
  };
}

interface Call {
  url: string;
  method: string;
}

function stubApi(onboarding: OnboardingState, calls: Call[] = []) {
  vi.stubGlobal('fetch', (input: string, init?: { method?: string }) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET' });
    const body = url.endsWith('/onboarding')
      ? onboarding
      : { items: 40, locations: 7, suppliers: 5, supplierItems: 100, movements: 1204 };
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });
  return calls;
}

function renderBanner() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const router = createMemoryRouter(
    [
      { path: '/dashboard', element: <DemoDataBanner /> },
      { path: '/welcome', element: <p>the welcome screen</p> },
    ],
    { initialEntries: ['/dashboard'] },
  );
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('the demo data sentence', () => {
  it('says the figures are invented, in those words', () => {
    expect(demoSentence(DEMO)).toMatch(/invented/i);
  });

  it('says how much of it there is and who put it there', () => {
    const sentence = demoSentence(DEMO);
    expect(sentence).toMatch(/40 made-up SKUs/);
    expect(sentence).toMatch(/1,204 movements/);
    expect(sentence).toMatch(/Ada Operator/);
  });
});

describe('DemoDataBanner', () => {
  it('says nothing on an instance that never loaded the demo', async () => {
    stubApi(state({ demo: null }));
    const { container } = renderBanner();

    // Give the query a turn to settle, so this is "stayed empty" rather than
    // "had not rendered yet".
    await vi.waitFor(() => expect(container.querySelector('button')).toBeNull());
    expect(screen.queryByText(/demo data/i)).not.toBeInTheDocument();
  });

  it('warns on whatever screen it is over', async () => {
    stubApi(state());
    renderBanner();

    expect(await screen.findByText(/every figure on these screens is invented/i)).toBeInTheDocument();
  });

  it('wipes on confirmation and lands back on the welcome screen', async () => {
    const calls = stubApi(state());
    renderBanner();

    await userEvent.click(await screen.findByRole('button', { name: /remove demo data/i }));
    // Named precisely so nobody presses it thinking it deletes everything.
    expect(await screen.findByText(/anything you created yourself stays/i)).toBeInTheDocument();

    const dialog = await screen.findByRole('alertdialog');
    await userEvent.click(
      await within(dialog).findByRole('button', { name: /remove demo data/i }),
    );

    expect(await screen.findByText('the welcome screen')).toBeInTheDocument();
    expect(calls).toContainEqual({ url: '/api/onboarding/demo', method: 'DELETE' });
  });

  it('offers a member no button it would refuse', async () => {
    stubApi(state({ canManageDemo: false }));
    renderBanner();

    expect(await screen.findByText(/an administrator can remove it/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /remove demo data/i })).not.toBeInTheDocument();
  });
});
