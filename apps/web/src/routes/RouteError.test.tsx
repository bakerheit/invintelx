import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import type { ClientErrorReport } from '@invintelx/shared';
import { RouteError } from './RouteError';
import { ApiError } from '@/lib/api';
import { resetErrorReporting } from '@/lib/errorReporting';

/**
 * Throws during render rather than from a loader. That is the case this
 * boundary exists for — a component blowing up mid-render is what previously
 * painted a blank page — and it keeps the test off react-router's data-fetching
 * machinery, which drags undici's Request into jsdom and clashes over
 * AbortSignal.
 */
function renderThrowing(thrown: unknown) {
  function Boom(): React.ReactNode {
    throw thrown;
  }

  const router = createMemoryRouter(
    [{ path: '/', errorElement: <RouteError />, element: <Boom /> }],
    { initialEntries: ['/'] },
  );
  return render(<RouterProvider router={router} />);
}

/**
 * The boundary now reports what it catches. Left unstubbed, every test in this
 * file would make a real POST at the happy-dom origin and litter the run with
 * connection refusals.
 */
const fetchMock = vi.fn();

function reports(): ClientErrorReport[] {
  return fetchMock.mock.calls.map(
    (call) => JSON.parse((call[1] as { body: string }).body) as ClientErrorReport,
  );
}

beforeEach(() => {
  resetErrorReporting();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RouteError', () => {
  it('catches a thrown Error instead of leaving a blank page', async () => {
    renderThrowing(new Error('the widget exploded'));
    expect(await screen.findByText('Something broke')).toBeInTheDocument();
    expect(screen.getByText('the widget exploded')).toBeInTheDocument();
  });

  it('shows status and statusText for a Response thrown by a loader', async () => {
    /*
     * Has to go through a loader. React Router only unwraps a thrown Response
     * into the ErrorResponse that isRouteErrorResponse recognises on the data
     * path; the same throw during render arrives as a plain unknown.
     */
    const router = createMemoryRouter(
      [
        {
          path: '/',
          errorElement: <RouteError />,
          loader: () => {
            throw new Response('No such item', { status: 404, statusText: 'Not Found' });
          },
          element: <p>should never render</p>,
        },
      ],
      { initialEntries: ['/'] },
    );
    render(<RouterProvider router={router} />);

    expect(await screen.findByText('404 Not Found')).toBeInTheDocument();
    expect(screen.getByText('No such item')).toBeInTheDocument();
  });

  it('uses the human-readable message from an ApiError', async () => {
    renderThrowing(new ApiError(409, 'conflict', 'That SKU is already in use'));
    expect(await screen.findByText('That SKU is already in use')).toBeInTheDocument();
  });

  it('degrades to a generic message for a non-Error throw', async () => {
    renderThrowing('a bare string');
    expect(await screen.findByText('An unexpected error occurred.')).toBeInTheDocument();
  });

  it('always offers a way back into the app', async () => {
    renderThrowing(new Error('boom'));
    expect(await screen.findByRole('link', { name: /back to items/i })).toHaveAttribute(
      'href',
      '/items',
    );
  });
});

describe('telling the server it happened', () => {
  it('reports the crash the user just saw', async () => {
    renderThrowing(new Error('the widget exploded'));
    await screen.findByText('Something broke');

    expect(reports()[0]).toMatchObject({ kind: 'render', message: 'the widget exploded' });
  });

  it('names the API request that failed, when there was one', async () => {
    renderThrowing(new ApiError(500, 'internal_error', 'The server gave up', undefined, 'req-11'));
    await screen.findByText('The server gave up');

    // This is the join: the browser stack and the server's 500 line, one id.
    expect(reports()[0]?.requestId).toBe('req-11');
  });

  it('stays quiet about a 404 from a loader', async () => {
    // The boundary rendered because that is how the router reports a missing
    // item, not because anything broke. Reporting it would bury the crashes.
    const router = createMemoryRouter(
      [
        {
          path: '/',
          errorElement: <RouteError />,
          loader: () => {
            throw new Response('No such item', { status: 404, statusText: 'Not Found' });
          },
          element: <p>should never render</p>,
        },
      ],
      { initialEntries: ['/'] },
    );
    render(<RouterProvider router={router} />);
    await screen.findByText('404 Not Found');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stays quiet about an expired session', async () => {
    renderThrowing(new ApiError(401, 'unauthorized', 'Authentication required'));
    await screen.findByText('Authentication required');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
