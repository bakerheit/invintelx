import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { DashboardPage } from './DashboardPage';

/** The series is windowed against the real clock, so fixtures are dated to it. */
function dayAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

function suggestion(overrides: Record<string, unknown> = {}) {
  return {
    itemId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    sku: 'BOLT-M6-30',
    name: 'Hex bolt M6 x 30mm',
    unitOfMeasure: 'each',
    onHand: 0,
    currentReorderPoint: 10,
    currentReorderQuantity: 50,
    averageDailyDemand: 4,
    demandStdDev: 1.5,
    leadTimeDays: 14,
    serviceLevel: '95',
    demandDuringLeadTime: 56,
    safetyStock: 9.2,
    suggestedReorderPoint: 66,
    suggestedOrderQuantity: 122,
    daysOfCover: 0,
    belowReorderPoint: true,
    valueOnHandCents: 0,
    dailyDemandValueCents: 480,
    ...overrides,
  };
}

function deadRow(overrides: Record<string, unknown> = {}) {
  return {
    itemId: 'cccccccccccccccccccccccc',
    sku: 'GASKET-88',
    name: 'Gasket 88mm',
    unitOfMeasure: 'each',
    onHand: 240,
    valueOnHandCents: 120_000,
    daysStale: 214,
    neverIssued: false,
    lastIssuedAt: '2025-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    generatedAt: '2026-08-26T09:00:00.000Z',
    windowDays: 90,
    leadTimeDays: 14,
    serviceLevel: '95',
    deadStockDays: 90,
    itemsConsidered: 42,
    stockouts: { total: 0, rows: [] },
    belowReorderPoint: { total: 0, rows: [] },
    deadStock: { total: 0, valueCents: 0, rows: [] },
    inventoryValueCents: 1_234_500,
    movementVolume: {
      windowDays: 90,
      totalUnits: 30,
      series: [
        { date: dayAgo(2), quantity: 10 },
        { date: dayAgo(1), quantity: 20 },
      ],
    },
    ...overrides,
  };
}

/**
 * The empty state asks the instance whether it is a first run, so the stub has
 * to answer that too — `onboarding` says whether there is anything in here at
 * all, which is a different question from whether any list has rows.
 */
function stubDashboard(body: unknown, status = 200, onboarding = onboardingState()) {
  vi.stubGlobal('fetch', (input: string) =>
    Promise.resolve(
      String(input).endsWith('/onboarding')
        ? new Response(JSON.stringify(onboarding), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        : new Response(JSON.stringify(body), {
            status,
            headers: { 'Content-Type': 'application/json' },
          }),
    ),
  );
}

function onboardingState(overrides: Record<string, unknown> = {}) {
  return {
    items: 42,
    locations: 7,
    movements: 900,
    empty: false,
    demo: null,
    canLoadDemo: false,
    canManageDemo: true,
    ...overrides,
  };
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const router = createMemoryRouter(
    [
      { path: '/dashboard', element: <DashboardPage /> },
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

/** The section whose heading contains this text. */
async function section(heading: RegExp) {
  const title = await screen.findByRole('heading', { name: heading, level: 2 });
  const element = title.closest('section');
  if (!element) throw new Error(`no section around "${heading.source}"`);
  return element;
}

afterEach(() => vi.unstubAllGlobals());

describe('DashboardPage', () => {
  it('says nothing needs a decision when no list has anything in it', async () => {
    stubDashboard(snapshot());
    renderPage();

    expect(await screen.findByText(/nothing needs a decision today/i)).toBeInTheDocument();
    // "42 SKUs checked" is what stops an empty screen reading as a broken one.
    expect(screen.getByText(/checked 42 active skus/i)).toBeInTheDocument();
    // ...and a screen that checked forty-two SKUs is not a first run.
    expect(screen.queryByRole('link', { name: /demo data/i })).not.toBeInTheDocument();
  });

  /*
   * A brand new instance and a quiet week both produce a dashboard with no rows
   * on it, and they want opposite things said. The first has nowhere to go from
   * here on its own terms, so it gets the one pointer the empty screens share.
   */
  it('sends a brand new instance somewhere it can actually start', async () => {
    stubDashboard(
      snapshot({ itemsConsidered: 0, inventoryValueCents: 0 }),
      200,
      onboardingState({ items: 0, locations: 0, movements: 0, empty: true }),
    );
    renderPage();

    expect(await screen.findByText(/because there is nothing here/i)).toBeInTheDocument();
    expect(
      await screen.findByRole('link', { name: /import a csv or load the demo data/i }),
    ).toBeInTheDocument();
  });

  it('does not render a section that has nothing in it', async () => {
    stubDashboard(
      snapshot({ stockouts: { total: 1, rows: [suggestion({ sku: 'OUT-1' })] } }),
    );
    renderPage();

    await screen.findByRole('heading', { name: /out of stock/i, level: 2 });
    expect(screen.queryByRole('heading', { name: /below reorder point/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /dead stock/i })).not.toBeInTheDocument();
  });

  it('separates what is out from what is merely low', async () => {
    stubDashboard(
      snapshot({
        stockouts: { total: 1, rows: [suggestion({ sku: 'OUT-1', onHand: 0 })] },
        belowReorderPoint: {
          total: 1,
          rows: [
            suggestion({
              itemId: 'bbbbbbbbbbbbbbbbbbbbbbbb',
              sku: 'LOW-1',
              onHand: 8,
              daysOfCover: 2,
            }),
          ],
        },
      }),
    );
    renderPage();

    expect(within(await section(/out of stock/i)).getByText('OUT-1')).toBeInTheDocument();
    expect(within(await section(/below reorder point/i)).getByText('LOW-1')).toBeInTheDocument();
    // The two lists are disjoint, so neither SKU appears in the other.
    expect(within(await section(/out of stock/i)).queryByText('LOW-1')).not.toBeInTheDocument();
  });

  it('links each row to the item it is about, named by SKU', async () => {
    stubDashboard(
      snapshot({
        stockouts: { total: 1, rows: [suggestion({ itemId: 'a'.repeat(24), sku: 'OUT-1' })] },
        deadStock: {
          total: 1,
          valueCents: 120_000,
          rows: [deadRow({ itemId: 'c'.repeat(24), sku: 'GASKET-88' })],
        },
      }),
    );
    renderPage();

    // A column of identical "Reorder" links tells a screen-reader user nothing.
    const reorder = await screen.findByRole('link', { name: 'Receive OUT-1' });
    expect(reorder).toHaveAttribute('href', `/items/${'a'.repeat(24)}`);
    expect(screen.getByRole('link', { name: 'Review GASKET-88' })).toHaveAttribute(
      'href',
      `/items/${'c'.repeat(24)}`,
    );
  });

  it('admits when a list is a shortlist', async () => {
    stubDashboard(
      snapshot({
        stockouts: {
          total: 23,
          rows: [suggestion({ sku: 'OUT-1' }), suggestion({ itemId: 'b'.repeat(24), sku: 'OUT-2' })],
        },
      }),
    );
    renderPage();

    // Two rows and two stockouts must not look like two rows out of 23.
    expect(await screen.findByText(/showing the worst 2 of 23 skus/i)).toBeInTheDocument();
  });

  it('does not claim a shortlist when the whole list is shown', async () => {
    stubDashboard(snapshot({ stockouts: { total: 1, rows: [suggestion()] } }));
    renderPage();

    await screen.findByRole('heading', { name: /out of stock/i, level: 2 });
    expect(screen.queryByText(/showing the worst/i)).not.toBeInTheDocument();
  });

  it('shows the working for a suggestion on demand rather than by default', async () => {
    stubDashboard(snapshot({ stockouts: { total: 1, rows: [suggestion()] } }));
    const { container } = renderPage();

    const toggle = await screen.findByRole('button', {
      name: /show the working for BOLT-M6-30/i,
    });
    expect(screen.queryByText(/how this was worked out/i)).not.toBeInTheDocument();

    toggle.click();
    // Nobody changes a reorder point because a black box said so, so the inputs
    // are one click away rather than hidden behind another screen.
    expect(await screen.findByText(/how this was worked out/i)).toBeInTheDocument();
    expect(container.textContent).toContain('Demand variability');
  });

  it('reports dead stock as money and as time sat still', async () => {
    stubDashboard(
      snapshot({
        deadStock: { total: 1, valueCents: 120_000, rows: [deadRow()] },
      }),
    );
    renderPage();

    const dead = await section(/dead stock/i);
    expect(within(dead).getByText('GASKET-88')).toBeInTheDocument();
    expect(within(dead).getByText('$1,200.00')).toBeInTheDocument();
    expect(within(dead).getByText(/214 days/)).toBeInTheDocument();
    expect(within(dead).getByText(/nothing issued for 90 days or more/i)).toBeInTheDocument();
  });

  it('marks dead stock that has never been issued at all', async () => {
    stubDashboard(
      snapshot({
        deadStock: {
          total: 1,
          valueCents: 500,
          rows: [deadRow({ valueOnHandCents: 500, neverIssued: true, lastIssuedAt: null })],
        },
      }),
    );
    renderPage();

    expect(within(await section(/dead stock/i)).getByText(/never issued/i)).toBeInTheDocument();
  });

  it('says late deliveries cannot be shown rather than showing none', async () => {
    stubDashboard(snapshot());
    renderPage();

    // An absent section reads as "no deliveries are late", and somebody would
    // believe it. Purchase orders do not exist yet, so the screen says so.
    const late = await section(/late incoming deliveries/i);
    expect(within(late).getByText(/purchase orders have not been built/i)).toBeInTheDocument();
  });

  it('carries total value and movement volume as context below the lists', async () => {
    stubDashboard(snapshot({ stockouts: { total: 1, rows: [suggestion()] } }));
    renderPage();

    expect(await screen.findByText('$12,345.00')).toBeInTheDocument();
    expect(screen.getByText(/at cost, across 42 active skus/i)).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /units moved weekly/i })).toBeInTheDocument();

    // Context, not headline: it sits after the thing it is context for.
    const out = await section(/out of stock/i);
    const context = screen.getByText(/total inventory value/i).closest('section');
    expect(out.compareDocumentPosition(context as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('says so plainly when nothing has moved', async () => {
    stubDashboard(snapshot({ movementVolume: { windowDays: 90, totalUnits: 0, series: [] } }));
    renderPage();

    expect(await screen.findByText(/no stock has moved in the last 90 days/i)).toBeInTheDocument();
  });

  it('reports a failure instead of an empty dashboard', async () => {
    stubDashboard({ error: { code: 'internal_error', message: 'the database is down' } }, 500);
    renderPage();

    expect(await screen.findByText(/could not build the dashboard/i)).toBeInTheDocument();
    expect(screen.getByText(/the database is down/i)).toBeInTheDocument();
    // Critically, not the "nothing needs a decision" card — a failed request is
    // not the same news as a healthy warehouse.
    expect(screen.queryByText(/nothing needs a decision/i)).not.toBeInTheDocument();
  });
});
