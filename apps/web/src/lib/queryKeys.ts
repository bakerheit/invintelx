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
  items: {
    all: ['items'] as const,
    list: (query: Record<string, unknown>) => ['items', 'list', query] as const,
    detail: (id: string) => ['items', 'detail', id] as const,
  },
} as const;
