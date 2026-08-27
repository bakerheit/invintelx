import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider } from 'react-router';
import type { CountSheetLine, Role } from '@invintelx/shared';
import { summariseCountSheet } from '@invintelx/shared';
import { AuthProvider } from '@/features/auth/AuthProvider';
import { CountSheetPage } from './CountSheetPage';

const SHEET_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const ACTOR_ID = 'dddddddddddddddddddddddd';
const BIN_ID = 'eeeeeeeeeeeeeeeeeeeeeeee';

let lastPostBody: unknown;
/** Answers the count that is being held open. See `stubApi`. */
let releaseCount: () => void = () => {};

function line(
  id: string,
  sku: string,
  expectedQuantity: number,
  countedQuantity: number | null,
): CountSheetLine {
  return {
    id,
    itemId: `${id.slice(0, 23)}f`,
    itemSku: sku,
    itemName: `Item ${sku}`,
    expectedQuantity,
    countedQuantity,
    variance: countedQuantity === null ? null : countedQuantity - expectedQuantity,
    countedAt: countedQuantity === null ? null : '2026-08-26T10:00:00.000Z',
    countedByName: countedQuantity === null ? '' : 'Jimmy Valmer',
    postedMovementId: null,
    postedQuantity: null,
  };
}

const LINES: CountSheetLine[] = [
  line('1111111111111111111111aa', 'ALPHA-1', 10, 9),
  line('2222222222222222222222bb', 'BETA-2', 10, 2),
  line('3333333333333333333333cc', 'GAMMA-3', 10, 10),
  line('4444444444444444444444dd', 'DELTA-4', 10, null),
];

function sheet(status: 'open' | 'posted' = 'open') {
  return {
    id: SHEET_ID,
    reference: 'CC-1A2B3C4D',
    locationId: BIN_ID,
    locationCode: 'A-01',
    locationPathLabel: 'MAIN / CHILLED / A-01',
    scope: 'location',
    status,
    note: '',
    summary: summariseCountSheet(LINES),
    createdAt: '2026-08-26T09:00:00.000Z',
    updatedAt: '2026-08-26T10:00:00.000Z',
    createdByName: 'Wendy Testaburger',
    postedAt: null,
    postedByName: '',
    cancelledAt: null,
    lines: LINES,
  };
}

function stubApi(role: Role, status: 'open' | 'posted' = 'open') {
  lastPostBody = undefined;
  releaseCount = () => {};

  vi.stubGlobal('fetch', (input: string, init?: RequestInit) => {
    const path = String(input).split('?')[0] ?? '';

    /*
     * Held open until the test says otherwise. "One line is saving" is a state
     * that only exists while a request is unanswered, so a stub that answered
     * immediately could not show what the rest of the screen does during it.
     */
    if (path.startsWith(`/api/counts/${SHEET_ID}/lines/`)) {
      return new Promise<Response>((resolve) => {
        releaseCount = () =>
          resolve(
            new Response(JSON.stringify(sheet(status)), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }),
          );
      });
    }

    if (path === '/api/auth/me') {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            user: {
              id: ACTOR_ID,
              email: 'wendy@invintelx.org',
              name: 'Wendy Testaburger',
              role,
              createdAt: '2026-08-01T00:00:00.000Z',
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    }

    if (path === `/api/counts/${SHEET_ID}/post`) {
      lastPostBody = JSON.parse(String(init?.body ?? '{}'));
      return Promise.resolve(
        new Response(
          JSON.stringify({ sheet: { ...sheet('posted') }, movements: [], balances: [] }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    }

    if (path === `/api/counts/${SHEET_ID}`) {
      return Promise.resolve(
        new Response(JSON.stringify(sheet(status)), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }

    return Promise.resolve(
      new Response(JSON.stringify({ error: { code: 'not_found', message: 'no stub' } }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const router = createMemoryRouter([{ path: '/counts/:id', element: <CountSheetPage /> }], {
    initialEntries: [`/counts/${SHEET_ID}`],
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </QueryClientProvider>,
  );
}

/** The SKUs in the order the table actually renders them. */
function renderedSkus(): string[] {
  return screen
    .getAllByRole('row')
    .slice(1)
    .map((row) => within(row).getAllByRole('cell')[1]?.textContent ?? '')
    .map((text) => text.split('Item ')[0] ?? '');
}

afterEach(() => vi.unstubAllGlobals());

describe('the variance report', () => {
  beforeEach(() => stubApi('member'));

  it('leads with the headline somebody in an aisle reads first', async () => {
    renderPage();
    const summary = await screen.findByLabelText('Variance summary');
    // Two lines wrong, nine units out: one short by 1 and one short by 8.
    expect(within(summary).getByText('2 short · 9 units out')).toBeInTheDocument();
    // The unfinished line is named as unfinished work, not folded into a total.
    expect(within(summary).getByText(/3 of 4 lines counted · 1 still to walk/)).toBeInTheDocument();
  });

  it('shows absolute and net units separately', async () => {
    renderPage();
    const summary = await screen.findByLabelText('Variance summary');
    expect(within(summary).getByText('Units out').previousSibling).toHaveTextContent('9');
    expect(within(summary).getByText('Net units').previousSibling).toHaveTextContent('-9');
  });

  it('counts in SKU order, so the next line stays under the finger', async () => {
    renderPage();
    await screen.findByLabelText('Variance summary');
    expect(renderedSkus()).toEqual(['ALPHA-1', 'BETA-2', 'GAMMA-3', 'DELTA-4']);
  });

  it('reviews worst first, with the agreeing line last', async () => {
    renderPage();
    await screen.findByLabelText('Variance summary');
    await userEvent.click(screen.getByRole('tab', { name: 'Worst first' }));
    expect(renderedSkus()).toEqual(['BETA-2', 'ALPHA-1', 'DELTA-4', 'GAMMA-3']);
  });

  it('says short and over in words, not only as a signed number', async () => {
    renderPage();
    await screen.findByLabelText('Variance summary');
    expect(screen.getByText('8 short')).toBeInTheDocument();
    expect(screen.getByText('Agrees')).toBeInTheDocument();
    expect(screen.getByText('Not counted')).toBeInTheDocument();
  });

  it('shows an uncounted line as a dash rather than as a zero', async () => {
    renderPage();
    await screen.findByLabelText('Variance summary');
    expect(screen.getByText('10 → —')).toBeInTheDocument();
  });
});

describe('accepting variances', () => {
  beforeEach(() => stubApi('member'));

  it('starts with nothing ticked, so accepting is a decision', async () => {
    renderPage();
    await screen.findByLabelText('Variance summary');
    expect(screen.getByText('Nothing ticked yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Accept 0 lines$/ })).toBeDisabled();
  });

  it('will not let an uncounted line be ticked', async () => {
    renderPage();
    await screen.findByLabelText('Variance summary');
    expect(
      screen.getByRole('checkbox', { name: 'Accept the variance for DELTA-4' }),
    ).toBeDisabled();
  });

  it('counts only the ticks that will write a movement', async () => {
    renderPage();
    await screen.findByLabelText('Variance summary');
    await userEvent.click(screen.getByRole('button', { name: 'Tick every counted line' }));

    // Three counted lines ticked; the one that agrees writes nothing.
    expect(screen.getByText('2 adjustments, -9 units net')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Accept 3 lines$/ })).toBeEnabled();
  });

  it('sends exactly the ticked lines', async () => {
    renderPage();
    await screen.findByLabelText('Variance summary');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Accept the variance for BETA-2' }));
    await userEvent.click(screen.getByRole('button', { name: /^Accept 1 line$/ }));

    expect(lastPostBody).toEqual({ lineIds: ['2222222222222222222222bb'], note: '' });
  });
});

describe('recording a count while walking a shelf', () => {
  beforeEach(() => stubApi('member'));
  afterEach(() => releaseCount());

  it('disables only the line being saved, so the next box is ready', async () => {
    renderPage();
    await screen.findByLabelText('Variance summary');

    const alpha = screen.getByLabelText('Counted quantity for ALPHA-1');
    await userEvent.clear(alpha);
    await userEvent.type(alpha, '7');
    await userEvent.tab();

    // The request for ALPHA-1 is in flight and deliberately unanswered.
    await waitFor(() => expect(alpha).toBeDisabled());

    // The next box down is where the finger is going, so it has to be live.
    expect(screen.getByLabelText('Counted quantity for BETA-2')).toBeEnabled();
    expect(screen.getByLabelText('Counted quantity for GAMMA-3')).toBeEnabled();
    // And a row that is not saving keeps the button that clears its count.
    expect(
      screen.getByRole('button', { name: 'Clear the count for BETA-2' }),
    ).toBeInTheDocument();

    releaseCount();
    await waitFor(() => expect(alpha).toBeEnabled());
  });
});

describe('a sheet that is not open', () => {
  beforeEach(() => stubApi('member', 'posted'));

  it('offers no entry boxes and no accept control', async () => {
    renderPage();
    await screen.findByLabelText('Variance summary');
    expect(screen.queryByLabelText('Counted quantity for ALPHA-1')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Accept/ })).not.toBeInTheDocument();
  });

  it('still reads as a report', async () => {
    renderPage();
    await screen.findByLabelText('Variance summary');
    expect(screen.getByText('8 short')).toBeInTheDocument();
  });
});

describe('a viewer', () => {
  beforeEach(() => stubApi('viewer'));

  it('reads the variances without being able to write any', async () => {
    renderPage();
    await screen.findByLabelText('Variance summary');
    expect(screen.getByText('8 short')).toBeInTheDocument();
    expect(screen.queryByLabelText('Counted quantity for ALPHA-1')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Accept/ })).not.toBeInTheDocument();
  });
});
