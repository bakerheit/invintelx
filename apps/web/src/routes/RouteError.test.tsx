import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { RouteError } from './RouteError';
import { ApiError } from '@/lib/api';

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
