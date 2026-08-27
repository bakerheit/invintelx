import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider } from 'react-router';
import type { Role } from '@invintelx/shared';
import { AuthProvider } from '@/features/auth/AuthProvider';
import { ItemDetailPage } from './ItemDetailPage';

const ITEM_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const ACTOR_ID = 'dddddddddddddddddddddddd';
const BIN_ID = 'eeeeeeeeeeeeeeeeeeeeeeee';

function movement(overrides: Record<string, unknown>) {
  return {
    id: 'bbbbbbbbbbbbbbbbbbbbbbbb',
    itemId: ITEM_ID,
    itemSku: 'BOLT-M6-30',
    itemName: 'Hex bolt M6 x 30mm',
    locationId: BIN_ID,
    locationCode: 'A-01',
    quantity: 25,
    type: 'receipt',
    reference: '',
    note: '',
    groupId: null,
    reversesId: null,
    purchaseOrderId: null,
    purchaseOrderLineId: null,
    reason: null,
    occurredAt: '2026-08-20T09:00:00.000Z',
    actorId: ACTOR_ID,
    actorName: 'Randy Marsh',
    createdAt: '2026-08-20T09:00:00.000Z',
    balanceAfter: 25,
    ...overrides,
  };
}

const HISTORY = [
  movement({ id: 'bbbbbbbbbbbbbbbbbbbbbbbb', type: 'receipt', quantity: 25, balanceAfter: 25 }),
  movement({
    id: 'cccccccccccccccccccccccc',
    type: 'transfer',
    quantity: -5,
    balanceAfter: 20,
    groupId: 'ffffffffffffffffffffffff',
  }),
];

/**
 * Every endpoint the page reaches for, answered from a table.
 *
 * The page fires five requests on mount and a missing one fails as a contract
 * mismatch three components deep, so they are all stubbed rather than only the
 * one under test.
 */
function stubApi(role: Role) {
  const responses: Record<string, unknown> = {
    '/api/auth/me': {
      user: {
        id: ACTOR_ID,
        email: 'randy@invintelx.org',
        name: 'Randy Marsh',
        role,
        createdAt: '2026-08-01T00:00:00.000Z',
      },
    },
    [`/api/items/${ITEM_ID}`]: {
      id: ITEM_ID,
      sku: 'BOLT-M6-30',
      name: 'Hex bolt M6 x 30mm',
      description: '',
      category: 'Fasteners',
      unitOfMeasure: 'each',
      barcode: '',
      unitCostCents: 120,
      unitPriceCents: 250,
      reorderPoint: 10,
      reorderQuantity: 50,
      status: 'active',
      attributes: {},
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-20T09:00:00.000Z',
    },
    [`/api/movements/stock/${ITEM_ID}`]: {
      itemId: ITEM_ID,
      totalOnHand: 20,
      byLocation: [
        {
          itemId: ITEM_ID,
          locationId: BIN_ID,
          locationCode: 'A-01',
          onHand: 20,
          updatedAt: '2026-08-20T09:00:00.000Z',
        },
      ],
    },
    [`/api/movements/history/${ITEM_ID}`]: {
      data: HISTORY,
      page: 1,
      pageSize: 20,
      total: 2,
      totalPages: 1,
    },
    [`/api/audit/item/${ITEM_ID}`]: {
      data: [
        {
          id: '111111111111111111111111',
          actorId: ACTOR_ID,
          actorName: 'Randy Marsh',
          action: 'update',
          entityType: 'item',
          entityId: ITEM_ID,
          entityLabel: 'BOLT-M6-30',
          changes: [
            { field: 'unitCostCents', before: 95, after: 120, redacted: false },
            { field: 'reorderPoint', before: 4, after: 10, redacted: false },
          ],
          createdAt: '2026-08-19T14:30:00.000Z',
        },
      ],
      page: 1,
      pageSize: 10,
      total: 1,
      totalPages: 1,
    },
    [`/api/analytics/demand/${ITEM_ID}`]: {
      stats: {
        itemId: ITEM_ID,
        windowDays: 90,
        totalIssued: 0,
        daysWithDemand: 0,
        averageDailyDemand: 0,
        demandStdDev: 0,
        series: [],
      },
      suggestion: {
        itemId: ITEM_ID,
        sku: 'BOLT-M6-30',
        name: 'Hex bolt M6 x 30mm',
        unitOfMeasure: 'each',
        onHand: 20,
        currentReorderPoint: 10,
        currentReorderQuantity: 50,
        averageDailyDemand: 0,
        demandStdDev: 0,
        leadTimeDays: 7,
        serviceLevel: '95',
        demandDuringLeadTime: 0,
        safetyStock: 0,
        suggestedReorderPoint: 0,
        suggestedOrderQuantity: 0,
        daysOfCover: null,
        belowReorderPoint: false,
        valueOnHandCents: 2400,
        dailyDemandValueCents: 0,
      },
    },
  };

  vi.stubGlobal('fetch', (input: string) => {
    const path = String(input).split('?')[0] ?? '';
    const body = responses[path];
    return Promise.resolve(
      new Response(JSON.stringify(body ?? { error: { code: 'not_found', message: 'no stub' } }), {
        status: body ? 200 : 404,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const router = createMemoryRouter([{ path: '/items/:id', element: <ItemDetailPage /> }], {
    initialEntries: [`/items/${ITEM_ID}`],
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </QueryClientProvider>,
  );
}

/** The history row for one movement, found by the balance it left behind. */
async function rowShowing(text: string) {
  const cell = await screen.findByText(text);
  const row = cell.closest('tr');
  if (!row) throw new Error(`no row around "${text}"`);
  return row;
}

afterEach(() => vi.unstubAllGlobals());

describe('ItemDetailPage movement history', () => {
  beforeEach(() => stubApi('member'));

  it('offers to reverse a receipt, on the row that made the balance wrong', async () => {
    renderPage();
    const row = await rowShowing('Received');
    expect(within(row).getByRole('button', { name: /reverse/i })).toBeInTheDocument();
  });

  /*
   * A transfer moves stock as a pair. Reversing one leg alone leaves -5 +5 +5 on
   * the books — five units nobody ever received — which is why the ledger
   * refuses it, and why the button is not offered rather than offered and then
   * rejected.
   */
  it('does not offer to reverse one leg of a transfer', async () => {
    renderPage();
    const row = await rowShowing('Transferred');
    expect(within(row).queryByRole('button', { name: /reverse/i })).not.toBeInTheDocument();
    expect(within(row).getByText('paired')).toBeInTheDocument();
  });

  it('still shows the balance after each movement', async () => {
    renderPage();
    const row = await rowShowing('Received');
    expect(within(row).getByText('25')).toBeInTheDocument();
  });
});

/**
 * The half of the story the ledger has never told. A movement explains the
 * quantity; nothing explained the cost or the reorder point until this section.
 */
describe('ItemDetailPage change history', () => {
  beforeEach(() => stubApi('member'));

  it('shows who changed a cost, and what it was before', async () => {
    renderPage();
    expect(await screen.findByText('Change history')).toBeInTheDocument();

    const label = await screen.findByText('Unit cost');
    const row = label.closest('div');
    if (!row) throw new Error('no row around the unit cost change');
    // Stored in cents, read as money — nobody argues about 12000.
    expect(within(row).getByText('$0.95')).toBeInTheDocument();
    expect(within(row).getByText('$1.20')).toBeInTheDocument();
  });

  it('shows a reorder point change, which has never had a home before now', async () => {
    renderPage();
    const label = await screen.findByText('Reorder point');
    const row = label.closest('div');
    if (!row) throw new Error('no row around the reorder point change');
    expect(within(row).getByText('4')).toBeInTheDocument();
    expect(within(row).getByText('10')).toBeInTheDocument();
  });
});

describe('ItemDetailPage for a viewer', () => {
  beforeEach(() => stubApi('viewer'));

  it('offers no way to reverse anything, since the ledger would refuse it', async () => {
    renderPage();
    await rowShowing('Received');
    expect(screen.queryByRole('button', { name: /reverse/i })).not.toBeInTheDocument();
  });
});
