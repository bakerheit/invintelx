import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router';

/**
 * A type alias, not an interface, so TypeScript grants it an implicit index
 * signature - that is what lets it be passed straight into a query key.
 */
export type TableParams = {
  page: number;
  pageSize: number;
  sort: string;
  order: 'asc' | 'desc';
  q: string;
  category: string;
  status: string;
};

const DEFAULTS: TableParams = {
  page: 1,
  pageSize: 25,
  sort: 'updatedAt',
  order: 'desc',
  q: '',
  category: '',
  status: 'active',
};

/**
 * Table state lives in the URL, so a filtered view is a link someone can paste
 * into chat and the browser back button steps through filters the way a user
 * expects rather than leaving the app.
 */
export function useTableParams(defaults: Partial<TableParams> = {}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const base = useMemo(() => ({ ...DEFAULTS, ...defaults }), [defaults]);

  const params = useMemo<TableParams>(() => {
    const page = Number(searchParams.get('page'));
    const pageSize = Number(searchParams.get('pageSize'));
    const order = searchParams.get('order');
    return {
      page: Number.isFinite(page) && page >= 1 ? page : base.page,
      pageSize: Number.isFinite(pageSize) && pageSize >= 1 ? pageSize : base.pageSize,
      sort: searchParams.get('sort') ?? base.sort,
      order: order === 'asc' || order === 'desc' ? order : base.order,
      q: searchParams.get('q') ?? base.q,
      category: searchParams.get('category') ?? base.category,
      status: searchParams.get('status') ?? base.status,
    };
  }, [searchParams, base]);

  const update = useCallback(
    (patch: Partial<TableParams>) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [key, value] of Object.entries(patch)) {
            const isDefault = value === base[key as keyof TableParams];
            // Keep the URL to only what differs from the defaults.
            if (value === '' || value === undefined || isDefault) next.delete(key);
            else next.set(key, String(value));
          }
          // Any change to what is being filtered invalidates the current page
          // number - page 7 of a narrower result set is usually empty.
          if (!('page' in patch)) next.delete('page');
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams, base],
  );

  const toggleSort = useCallback(
    (field: string) => {
      if (params.sort === field) update({ order: params.order === 'asc' ? 'desc' : 'asc' });
      else update({ sort: field, order: 'asc' });
    },
    [params.sort, params.order, update],
  );

  return { params, update, toggleSort };
}
