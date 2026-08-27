import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MoveForm } from './MoveForm';

const ITEM_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const BIN_ID = 'eeeeeeeeeeeeeeeeeeeeeeee';
const BARCODE = '5012345678900';

const ITEM = {
  id: ITEM_ID,
  sku: 'BOLT-M6-30',
  name: 'Hex bolt M6 x 30mm',
  description: '',
  category: 'Fasteners',
  unitOfMeasure: 'each',
  barcode: BARCODE,
  unitCostCents: 120,
  unitPriceCents: 250,
  reorderPoint: 10,
  reorderQuantity: 50,
  status: 'active',
  attributes: {},
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-20T09:00:00.000Z',
};

function page(data: unknown[]) {
  return { data, page: 1, pageSize: 8, total: data.length, totalPages: 1 };
}

/**
 * The lookup endpoint, told which codes it knows about.
 *
 * Exact only, like the real one: handing back a partial match would let a test
 * pass that the server would fail.
 */
function stubApi(known: Record<string, unknown> = { [BARCODE]: ITEM }) {
  vi.stubGlobal('fetch', (input: string) => {
    const url = String(input);
    const [path, search = ''] = url.split('?');

    const json = (body: unknown, status: number) =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

    if (path === '/api/items/lookup') {
      const code = new URLSearchParams(search).get('code') ?? '';
      const found = known[code];
      return found
        ? json(found, 200)
        : json({ error: { code: 'not_found', message: `No item has the SKU or barcode ${code}` } }, 404);
    }

    if (path === '/api/items') return json(page([ITEM]), 200);
    if (path === '/api/locations') return json(page([]), 200);
    if (path === `/api/movements/stock/${ITEM_ID}`) {
      return json({ itemId: ITEM_ID, totalOnHand: 0, byLocation: [] }, 200);
    }
    return json({ error: { code: 'not_found', message: 'no stub' } }, 404);
  });
}

function renderForm() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MoveForm kind="receive" />
    </QueryClientProvider>,
  );
}

/**
 * A keyboard-wedge scanner, as far as the DOM can tell.
 *
 * Dispatched synchronously, so the real gaps between these events are well
 * under a millisecond — which is exactly what makes it a scanner and not a
 * person. Nothing about the clock is mocked.
 */
function scan(code: string, target: Element = document.body) {
  for (const char of code) fireEvent.keyDown(target, { key: char });
  fireEvent.keyDown(target, { key: 'Enter' });
}

beforeEach(() => stubApi());
afterEach(() => vi.unstubAllGlobals());

describe('scanning into a movement form', () => {
  it('resolves a barcode to its item and puts the cursor in the quantity box', async () => {
    renderForm();

    scan(BARCODE);

    // The picker is showing the item, so nobody typed a SKU from memory.
    expect(await screen.findByText('Hex bolt M6 x 30mm')).toBeInTheDocument();
    expect(screen.getByText('BOLT-M6-30')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('Quantity')).toHaveFocus());
  });

  it('resolves a SKU the same way as a barcode', async () => {
    stubApi({ 'BOLT-M6-30': ITEM });
    renderForm();

    scan('BOLT-M6-30');

    expect(await screen.findByText('Hex bolt M6 x 30mm')).toBeInTheDocument();
  });

  /*
   * The ticket's reason for existing: silence here is a pallet nobody recorded.
   * The failure has to still be on screen when the operator looks up.
   */
  it('says so loudly when a code matches nothing, and offers to create it', async () => {
    renderForm();

    scan('9999999999999');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('9999999999999');
    expect(screen.getByRole('button', { name: /create this item/i })).toBeInTheDocument();
  });

  /*
   * The code goes back into the dialog as a barcode, not a SKU — thirteen digits
   * is a GTIN, and retyping it off the label is the transcription error this
   * whole feature exists to remove.
   */
  it('opens the create dialog with the unrecognised code already filled in', async () => {
    const user = userEvent.setup();
    renderForm();

    scan('9999999999999');
    await user.click(await screen.findByRole('button', { name: /create this item/i }));

    expect(await screen.findByLabelText('Barcode')).toHaveValue('9999999999999');
    expect(screen.getByLabelText('SKU')).toHaveValue('');
  });

  /*
   * The ledger refuses to move stock against an archived item, so finding one is
   * not a success — and it is not an invitation to create a duplicate SKU either.
   */
  it('refuses an archived item by name rather than offering to create it again', async () => {
    stubApi({ 'GONE-1': { ...ITEM, sku: 'GONE-1', status: 'archived' } });
    renderForm();

    scan('GONE-1');

    expect(await screen.findByRole('alert')).toHaveTextContent(/GONE-1 is archived/);
    expect(screen.queryByRole('button', { name: /create this item/i })).not.toBeInTheDocument();
  });

  it('ignores a code typed into the reference field, which is somebody writing', async () => {
    const user = userEvent.setup();
    renderForm();

    const reference = screen.getByLabelText('Reference');
    await user.click(reference);
    scan(BARCODE, reference);

    // No item was chosen, and what they typed is theirs.
    expect(screen.queryByText('Hex bolt M6 x 30mm')).not.toBeInTheDocument();
  });

  /*
   * jsdom and happy-dom have no BarcodeDetector, and neither do Firefox or
   * desktop Safari. The dialog has to say which it is rather than showing a
   * viewfinder that will never resolve anything.
   */
  it('says plainly when the browser cannot read barcodes from the camera', async () => {
    const user = userEvent.setup();
    renderForm();

    await user.click(screen.getByRole('button', { name: /use the camera/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/cannot read barcodes from its camera/i);
    expect(screen.queryByTestId('scan-viewfinder')).not.toBeInTheDocument();
  });
});
