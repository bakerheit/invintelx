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

/** Every movement the form managed to post, in order. */
const posted: unknown[] = [];

/**
 * The lookup endpoint, told which codes it knows about.
 *
 * Exact only, like the real one: handing back a partial match would let a test
 * pass that the server would fail.
 */
function stubApi(known: Record<string, unknown> = { [BARCODE]: ITEM }) {
  vi.stubGlobal('fetch', (input: string, init?: RequestInit) => {
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
    if (path === '/api/locations') return json(page([BIN]), 200);
    if (path === `/api/movements/stock/${ITEM_ID}`) {
      return json({ itemId: ITEM_ID, totalOnHand: 0, byLocation: [] }, 200);
    }

    // The write. Recorded rather than merely answered, because the assertion
    // that matters below is that it never happened.
    if (path === '/api/movements/receive' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      posted.push(body);
      return json(
        {
          movement: {
            id: 'ffffffffffffffffffffffff',
            itemId: ITEM_ID,
            itemSku: ITEM.sku,
            itemName: ITEM.name,
            locationId: BIN_ID,
            locationCode: BIN.code,
            quantity: body.quantity,
            type: 'receipt',
            reference: '',
            note: '',
            groupId: null,
            reversesId: null,
            reason: null,
            occurredAt: '2026-08-28T09:00:00.000Z',
            actorId: 'bbbbbbbbbbbbbbbbbbbbbbbb',
            actorName: 'Test',
            createdAt: '2026-08-28T09:00:00.000Z',
          },
          balanceAfter: body.quantity,
        },
        200,
      );
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
 *
 * The Shift keydowns are the point of the fidelity. A wedge sends uppercase by
 * setting the HID modifier bit, and the OS turns that transition into a keydown
 * of its own that lands in the middle of the code — so every SKU scanned here
 * puts a modifier through the buffer, which is what nothing in the suite used
 * to do. Releasing Shift is a keyup and never reaches a keydown listener, so
 * only the presses are dispatched.
 */
function scan(code: string, target: Element = document.body) {
  let shifted = false;
  for (const char of code) {
    const needsShift = /[A-Z]/.test(char);
    if (needsShift && !shifted) fireEvent.keyDown(target, { key: 'Shift', shiftKey: true });
    shifted = needsShift;
    fireEvent.keyDown(target, { key: char, shiftKey: needsShift });
  }
  fireEvent.keyDown(target, { key: 'Enter' });
}

/**
 * Hold the thread for `ms`, without yielding.
 *
 * Two things need this and neither can fake it with timers. A person putting a
 * pen down before reaching for the gun leaves a gap of hundreds of milliseconds;
 * in a test their keystrokes and the scan are microseconds apart, which is one
 * unbroken run and glues the digits they typed onto the front of the code. And
 * jank is by definition the thread not being yielded.
 */
function holdTheThread(ms: number) {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    /* deliberately busy */
  }
}

/**
 * One keydown carrying the timestamp the UA would have stamped on it.
 *
 * `fireEvent`'s own events are stamped when they are constructed, which is
 * faithful but not controllable. These tests need to drive the event clock and
 * the wall clock apart, because telling them apart is the whole assertion.
 *
 * Returns false when a listener called `preventDefault` — which is how a
 * held-back Enter is asserted without depending on whether this DOM implements
 * implicit form submission.
 */
function keyAt(key: string, at: number, target: Element = document.body) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  Object.defineProperty(event, 'timeStamp', { value: at });
  return fireEvent(target, event);
}

/** Open a picker and take the only option in it. */
async function pick(user: ReturnType<typeof userEvent.setup>, label: string, option: string) {
  await user.click(await screen.findByRole('combobox', { name: label }));
  await user.click(await screen.findByRole('option', { name: new RegExp(option) }));
}

/**
 * A form one keystroke away from posting, with the cursor where a scan leaves it.
 *
 * Item from a scan, bin chosen by hand, and `quantity` holding what a scan would
 * have leaked into it — `SUPPRESS_AFTER` lets the first three characters of
 * every code through, and this box is where the previous scan put the cursor.
 */
async function armedForm(user: ReturnType<typeof userEvent.setup>, leaked: string) {
  renderForm();
  await pick(user, 'Bin', 'A-01');

  scan(BARCODE);
  const quantity = await screen.findByLabelText('Quantity');
  await waitFor(() => expect(quantity).toHaveFocus());

  await user.type(quantity, leaked);
  posted.length = 0;
  return quantity;
}

beforeEach(() => {
  posted.length = 0;
  stubApi();
});
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

  /*
   * Reaching the lookup at all means the Shift keydowns between BOLT and M6-30
   * did not abandon the run. A buffer that treats a modifier as somebody
   * reaching for a key asks the server about M6-30 instead.
   */
  it('resolves a SKU the same way as a barcode, modifier keydowns and all', async () => {
    stubApi({ 'BOLT-M6-30': ITEM });
    renderForm();

    scan('BOLT-M6-30');

    expect(await screen.findByText('Hex bolt M6 x 30mm')).toBeInTheDocument();
  });

  /*
   * A code ending in uppercase is the failure that makes no noise: the tail
   * after the last modifier is too short to be a scan, so nothing happens and
   * nobody is told. Silence here is the pallet the ticket is about.
   */
  it('resolves a SKU that ends in uppercase, where a dropped modifier means silence', async () => {
    stubApi({ 'ABC-123-XY': { ...ITEM, sku: 'ABC-123-XY' } });
    renderForm();

    scan('ABC-123-XY');

    expect(await screen.findByText('Hex bolt M6 x 30mm')).toBeInTheDocument();
    expect(screen.getByText('ABC-123-XY')).toBeInTheDocument();
  });

  /*
   * The gap that decides this is 35ms, which one ordinary React render can
   * swallow. Here the UA stamped the keystrokes at scanner speed and the page
   * then took 60ms to get round to the last one — a clock read inside the
   * listener calls that a person and abandons the code halfway through.
   */
  it('reads a scan through a render longer than the gap it is judged by', async () => {
    renderForm();

    let at = 1_000;
    for (const char of BARCODE) {
      keyAt(char, at);
      at += 8;
    }

    // The way a re-render of the movements page holds it.
    holdTheThread(60);
    keyAt('Enter', at);

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

  /*
   * A scan voids the quantity whatever it resolves to, and the failing paths are
   * the ones that need it. The cursor is already in this box — the previous scan
   * put it there — so the first characters of the next code land in it, and the
   * count somebody typed against the last SKU is sitting under them. Clear only
   * on success and an unknown code leaves both behind with the cursor after
   * them, which posts a number nobody entered.
   */
  it('empties the quantity box on a scan that resolves to nothing', async () => {
    const user = userEvent.setup();
    renderForm();

    scan(BARCODE);
    const quantity = await screen.findByLabelText('Quantity');
    await waitFor(() => expect(quantity).toHaveFocus());
    await user.type(quantity, '12');
    expect(quantity).toHaveValue(12);

    holdTheThread(50);
    scan('9999999999999', quantity);

    // Named exactly, so the assertion cannot be satisfied by the typed digits
    // riding along on the front of the code.
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Nothing in the catalogue has the SKU or barcode 9999999999999.',
    );
    expect(quantity).toHaveValue(null);
  });

  /*
   * Same guarantee on the other failing branch: an archived hit never reaches
   * the form's onItem either.
   */
  it('empties the quantity box on a scan that lands on an archived item', async () => {
    const user = userEvent.setup();
    stubApi({ [BARCODE]: ITEM, 'GONE-1': { ...ITEM, sku: 'GONE-1', status: 'archived' } });
    renderForm();

    scan(BARCODE);
    const quantity = await screen.findByLabelText('Quantity');
    await waitFor(() => expect(quantity).toHaveFocus());
    await user.type(quantity, '12');

    holdTheThread(50);
    scan('GONE-1', quantity);

    expect(await screen.findByRole('alert')).toHaveTextContent(/GONE-1 is archived/);
    expect(quantity).toHaveValue(null);
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
   * The quantity nobody typed, end to end. A wedge that stutters past the 35ms
   * gap breaks one code into two runs; the second is too short to be a code, so
   * no lookup fires and `onScanStart` never clears the box. Its characters are
   * in the quantity field, the item and bin are still selected from the scan
   * before it, and the Enter that ends the run would post the lot.
   */
  it("holds back a truncated run's Enter before it can submit the form", async () => {
    const user = userEvent.setup();
    const quantity = await armedForm(user, '900');

    // The tail of the broken run, at scanner speed, ending in its Enter.
    const at = performance.now() + 1_000;
    keyAt('9', at, quantity);
    keyAt('0', at + 8, quantity);
    keyAt('0', at + 16, quantity);
    const wentThrough = keyAt('Enter', at + 24, quantity);

    /*
     * `preventDefault` on the keydown is what stops the implicit submit, and it
     * is what this asserts. happy-dom does not implement implicit submission at
     * all, so the empty `posted` below corroborates rather than proves — the
     * defaultPrevented is the load-bearing half, and the next test shows the
     * same key in the same state is left alone when a person sent it.
     */
    expect(wentThrough).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(posted).toEqual([]);
    // Nothing was posted and nothing was reset, so what is on screen is still
    // the operator's to correct.
    expect(quantity).toHaveValue(900);
  });

  /*
   * The same failure in the item picker, which is the other place a scan is
   * allowed to interrupt. SearchPicker reads Enter in its own `onKeyDown` as
   * "take the highlighted row", and `preventDefault` does not stop a React
   * handler — so a truncated run's Enter has to be kept out of the handler too,
   * or it books stock against whatever partial match the leaked characters left
   * the list showing.
   */
  it("does not let a truncated run's Enter take the highlighted row in the picker", async () => {
    const user = userEvent.setup();
    renderForm();

    const search = await screen.findByRole('combobox', { name: 'Item' });
    await user.click(search);
    expect(await screen.findByRole('option', { name: /BOLT-M6-30/ })).toBeInTheDocument();

    const at = performance.now() + 1_000;
    keyAt('9', at, search);
    keyAt('0', at + 8, search);
    keyAt('0', at + 16, search);
    keyAt('Enter', at + 24, search);

    // Nothing chosen: a chosen value swaps the search box for the chosen-row
    // view, so the combobox still being here is the assertion.
    expect(screen.getByRole('combobox', { name: 'Item' })).toBeInTheDocument();

    // And a person's Enter, in that same open list, still takes the row.
    keyAt('Enter', at + 600, search);
    await waitFor(() =>
      expect(screen.queryByRole('combobox', { name: 'Item' })).not.toBeInTheDocument(),
    );
  });

  /*
   * The other half of the same rule, and the reason it is drawn on the clock.
   * Identical state, identical key — an Enter that is not sitting on the heels
   * of a keystroke is somebody submitting the form, and it reaches it untouched.
   */
  it('leaves an Enter a person could have pressed alone, on a form one submit from posting', async () => {
    const user = userEvent.setup();
    const quantity = await armedForm(user, '12');

    const at = performance.now() + 1_000;
    keyAt('1', at, quantity);
    keyAt('2', at + 150, quantity);

    expect(keyAt('Enter', at + 400, quantity)).toBe(true);

    // And the state really was one submit away the whole time, so the test above
    // was refusing something that would otherwise have posted. The button stands
    // in for the Enter this DOM will not act on by itself.
    await user.click(screen.getByRole('button', { name: /receive stock/i }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({ itemId: ITEM_ID, locationId: BIN_ID, quantity: 12 });
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
