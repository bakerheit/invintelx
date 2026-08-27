/**
 * Query keys in one place. Invalidating "all items" is then a real, typed
 * operation rather than guessing which string some component used.
 *
 * List keys take a loose record on purpose: the filter values come from the
 * URL, where a user can type anything. Validating them is the server's job -
 * here they only need to be stable and serialisable so two identical views
 * share a cache entry.
 */
export const queryKeys = {
  session: ['session'] as const,
  setupStatus: ['auth', 'setup'] as const,
  dashboard: (query: Record<string, unknown>) => ['dashboard', query] as const,
  items: {
    /**
     * Prefix for everything hanging off an item, stock and history included.
     * Posting a movement invalidates this one key and every item view that could
     * have moved refetches, rather than each screen remembering to.
     */
    all: ['items'] as const,
    list: (query: Record<string, unknown>) => ['items', 'list', query] as const,
    detail: (id: string) => ['items', 'detail', id] as const,
    stock: (id: string) => ['items', 'stock', id] as const,
    history: (id: string, page: number, pageSize: number) =>
      ['items', 'history', id, page, pageSize] as const,
    demand: (id: string) => ['items', 'demand', id] as const,
  },
  locations: {
    all: ['locations'] as const,
    list: (query: Record<string, unknown>) => ['locations', 'list', query] as const,
  },
  movements: {
    all: ['movements'] as const,
    list: (query: Record<string, unknown>) => ['movements', 'list', query] as const,
  },
  counts: {
    all: ['counts'] as const,
    /**
     * The prefix every list shares, so "the lists are stale" can be said
     * without also invalidating the sheet a mutation just handed back in full.
     * `list({})` is not that prefix — a query object in the key is matched by
     * value, so it would only ever match a list with no filters at all.
     */
    lists: ['counts', 'list'] as const,
    list: (query: Record<string, unknown>) => ['counts', 'list', query] as const,
    detail: (id: string) => ['counts', 'detail', id] as const,
  },
} as const;
