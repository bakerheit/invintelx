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
  /** What this instance holds, and whether the demo dataset is part of it. */
  onboarding: ['onboarding'] as const,
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
} as const;
