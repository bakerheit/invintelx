import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TransferForm } from './TransferForm';

const ITEM_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const BIN_A = 'eeeeeeeeeeeeeeeeeeeeeeee';
const BIN_B = 'ffffffffffffffffffffffff';

const ITEM = {
  id: ITEM_ID,
  sku: 'BOLT-M6-30',
  name: 'Hex bolt M6 x 30mm',
  description: '',
  category: '',
  unitOfMeasure: 'each',
  barcode: '',
  unitCostCents: 0,
  unitPriceCents: 0,
  reorderPoint: 0,
  reorderQuantity: 0,
  status: 'active',
  attributes: {},
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
};

function bin(id: string, code: string) {
  return {
    id,
    code,
    name: `Rack ${code}`,
    type: 'bin',
    parentId: null,
    path: [id],
    pathLabel: `MAIN / ${code}`,
    isActive: true,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  };
}

function page(data: unknown[]) {
  return { data, page: 1, pageSize: 8, total: data.length, totalPages: 1 };
}

const posted = vi.fn();

function stubApi() {
  const responses: Record<string, unknown> = {
    '/api/items': page([ITEM]),
    '/api/locations': page([bin(BIN_A, 'A-01'), bin(BIN_B, 'B-02')]),
    [`/api/movements/stock/${ITEM_ID}`]: {
      itemId: ITEM_ID,
      totalOnHand: 20,
      byLocation: [
        {
          itemId: ITEM_ID,
          locationId: BIN_A,
          locationCode: 'A-01',
          onHand: 20,
          updatedAt: '2026-08-01T00:00:00.000Z',
        },
      ],
    },
  };

  vi.stubGlobal('fetch', (input: string, init?: { method?: string }) => {
    const path = String(input).split('?')[0] ?? '';
    if (init?.method === 'POST') posted(path);
    const body = responses[path];
    return Promise.resolve(
      new Response(JSON.stringify(body ?? { error: { code: 'not_found', message: 'no stub' } }), {
        status: body ? 200 : 404,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });
}

function renderForm() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <TransferForm />
    </QueryClientProvider>,
  );
}

async function pick(user: ReturnType<typeof userEvent.setup>, label: string, option: string) {
  await user.click(await screen.findByRole('combobox', { name: label }));
  await user.click(await screen.findByRole('option', { name: new RegExp(option) }));
}

beforeEach(() => {
  posted.mockClear();
  stubApi();
});
afterEach(() => vi.unstubAllGlobals());

describe('the transfer form', () => {
  /*
   * The ledger refuses a same-bin transfer, because it is a no-op that still
   * writes two rows and two projection updates. Catching it here means somebody
   * finds out from the field they got wrong rather than from a round trip.
   */
  it('refuses a transfer into the bin it came from, without asking the server', async () => {
    const user = userEvent.setup();
    renderForm();

    await pick(user, 'Item', 'BOLT-M6-30');
    await pick(user, 'From bin', 'A-01');
    await pick(user, 'To bin', 'A-01');
    await user.type(screen.getByLabelText('Quantity'), '5');
    await user.click(screen.getByRole('button', { name: /move stock/i }));

    expect(await screen.findByText('Pick two different bins')).toBeInTheDocument();
    expect(posted).not.toHaveBeenCalled();
  });

  it('warns when the source bin would go negative, and still allows it', async () => {
    const user = userEvent.setup();
    renderForm();

    await pick(user, 'Item', 'BOLT-M6-30');
    await pick(user, 'From bin', 'A-01');
    await pick(user, 'To bin', 'B-02');
    await user.type(screen.getByLabelText('Quantity'), '25');

    expect(await screen.findByText('A-01 holds 20. This takes it to -5.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /move stock/i })).toBeEnabled();
  });
});
