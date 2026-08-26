import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MoveForm } from './MoveForm';

const ITEM_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const BIN_ID = 'eeeeeeeeeeeeeeeeeeeeeeee';

const ITEM = {
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
};

const BIN = {
  id: BIN_ID,
  code: 'A-01',
  name: 'Rack A bay 1',
  type: 'bin',
  parentId: null,
  path: [BIN_ID],
  pathLabel: 'MAIN / CHILLED / A-01',
  isActive: true,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
};

function page(data: unknown[]) {
  return { data, page: 1, pageSize: 8, total: data.length, totalPages: 1 };
}

/** On-hand is 20 at A-01, so anything over 20 should warn and nothing should block. */
function stubApi() {
  const responses: Record<string, unknown> = {
    '/api/items': page([ITEM]),
    '/api/locations': page([BIN]),
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

function renderForm() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MoveForm kind="issue" />
    </QueryClientProvider>,
  );
}

/** Open a picker and take the only option in it. */
async function pick(user: ReturnType<typeof userEvent.setup>, label: string, option: string) {
  await user.click(await screen.findByRole('combobox', { name: label }));
  await user.click(await screen.findByRole('option', { name: new RegExp(option) }));
}

beforeEach(() => stubApi());
afterEach(() => vi.unstubAllGlobals());

describe('the issue form', () => {
  it('chooses an item and a bin by searching, never by id', async () => {
    const user = userEvent.setup();
    renderForm();

    await pick(user, 'Item', 'BOLT-M6-30');
    await pick(user, 'Bin', 'A-01');

    // Both pickers are now showing what was chosen, and neither shows an id.
    expect(screen.getByText('Hex bolt M6 x 30mm')).toBeInTheDocument();
    expect(screen.getByText('MAIN / CHILLED / A-01')).toBeInTheDocument();
    expect(screen.queryByText(ITEM_ID)).not.toBeInTheDocument();
    expect(screen.queryByText(BIN_ID)).not.toBeInTheDocument();
  });

  /*
   * The whole point of the ticket's "warning rather than a refusal". Stock
   * physically leaves before the paperwork catches up, so an issue that overdraws
   * a bin has to be recordable — the screen says what it will do and gets out of
   * the way.
   */
  it('warns that the bin would go negative, and still lets the movement through', async () => {
    const user = userEvent.setup();
    renderForm();

    await pick(user, 'Item', 'BOLT-M6-30');
    await pick(user, 'Bin', 'A-01');
    await user.type(screen.getByLabelText('Quantity'), '30');

    expect(await screen.findByText('A-01 holds 20. This takes it to -10.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /issue stock/i })).toBeEnabled();
  });

  it('says nothing when the bin has enough', async () => {
    const user = userEvent.setup();
    renderForm();

    await pick(user, 'Item', 'BOLT-M6-30');
    await pick(user, 'Bin', 'A-01');
    await user.type(screen.getByLabelText('Quantity'), '5');

    expect(screen.queryByText(/takes it to/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /issue stock/i })).toBeEnabled();
  });
});
