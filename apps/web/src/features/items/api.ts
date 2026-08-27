import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  itemDemandResponseSchema,
  itemImportPreviewSchema,
  itemImportResultSchema,
  itemListResponseSchema,
  itemSchema,
  itemStockSchema,
  movementHistoryResponseSchema,
  type CreateItemInput,
  type Item,
  type ItemImportRequest,
  type UpdateItemInput,
} from '@invintelx/shared';
import { apiRequest, toQueryString } from '@/lib/api';
import type { TableParams } from '@/hooks/useTableParams';
import { queryKeys } from '@/lib/queryKeys';

/** The list screen's filter state, which is exactly the URL-backed table state. */
export type ItemsQuery = TableParams;

/**
 * What goes stale when an item is written.
 *
 * Every write to an item now also appends to the audit log, so the trail on the
 * detail page is downstream of the same mutations the item itself is. Keeping
 * the pair in one function is what stops the next mutation from remembering one
 * and forgetting the other.
 */
function invalidateAfterWrite(queryClient: QueryClient): Promise<void> {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.items.all }),
    queryClient.invalidateQueries({ queryKey: queryKeys.audit.all }),
  ]).then(() => undefined);
}

export function useItems(query: ItemsQuery) {
  return useQuery({
    queryKey: queryKeys.items.list(query),
    queryFn: () =>
      apiRequest(itemListResponseSchema, `/items${toQueryString({ ...query })}`),
    // Keeps the previous page on screen while the next one loads, so paging
    // does not flash an empty table.
    placeholderData: (previous) => previous,
  });
}

export function useCreateItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateItemInput) =>
      apiRequest(itemSchema, '/items', { method: 'POST', body: input }),
    onSuccess: () => invalidateAfterWrite(queryClient),
  });
}

export function useUpdateItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateItemInput }) =>
      apiRequest(itemSchema, `/items/${id}`, { method: 'PATCH', body: input }),
    onSuccess: () => invalidateAfterWrite(queryClient),
  });
}

export function useArchiveItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (item: Item) =>
      apiRequest(itemSchema, `/items/${item.id}/archive`, { method: 'POST' }),
    onSuccess: () => invalidateAfterWrite(queryClient),
  });
}

export function useRestoreItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (item: Item) =>
      apiRequest(itemSchema, `/items/${item.id}/restore`, { method: 'POST' }),
    onSuccess: () => invalidateAfterWrite(queryClient),
  });
}

/**
 * What the file would do. Deliberately not a query: it is not cacheable state,
 * it is an answer to one particular file the user is holding, and asking again
 * after somebody else has edited an item should give a different answer.
 */
export function usePreviewImport() {
  return useMutation({
    mutationFn: (input: ItemImportRequest) =>
      apiRequest(itemImportPreviewSchema, '/items/import/preview', {
        method: 'POST',
        body: input,
      }),
  });
}

export function useCommitImport() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ItemImportRequest) =>
      apiRequest(itemImportResultSchema, '/items/import', { method: 'POST', body: input }),
    onSuccess: () => invalidateAfterWrite(queryClient),
  });
}

/**
 * The export is a plain link rather than a fetch: the browser already knows how
 * to save a file the server marked as an attachment, and doing it by hand means
 * holding the whole thing in memory as a blob for no gain.
 */
export function itemsExportHref(query: Pick<ItemsQuery, 'q' | 'category' | 'status'>): string {
  return `/api/items/export.csv${toQueryString({
    q: query.q,
    category: query.category,
    status: query.status,
  })}`;
}

/**
 * One scanned code to one item.
 *
 * A mutation rather than a query, for the same reason the import preview is:
 * it is an imperative answer to a thing that just happened in the aisle, not a
 * piece of state a screen renders. Caching it would also mean a code that
 * resolved to nothing keeps resolving to nothing after somebody creates the
 * item it was missing.
 */
export function useItemLookup() {
  return useMutation({
    mutationFn: (code: string) => apiRequest(itemSchema, `/items/lookup${toQueryString({ code })}`),
  });
}

export function useItem(id: string) {
  return useQuery({
    queryKey: queryKeys.items.detail(id),
    queryFn: () => apiRequest(itemSchema, `/items/${id}`),
  });
}

/** On-hand for one item, broken down by the bins holding it. */
export function useItemStock(id: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.items.stock(id),
    queryFn: () => apiRequest(itemStockSchema, `/movements/stock/${id}`),
    enabled: enabled && id !== '',
  });
}

export function useItemHistory(id: string, page: number, pageSize = 20) {
  return useQuery({
    queryKey: queryKeys.items.history(id, page, pageSize),
    queryFn: () =>
      apiRequest(
        movementHistoryResponseSchema,
        `/movements/history/${id}${toQueryString({ page, pageSize })}`,
      ),
    placeholderData: (previous) => previous,
  });
}

export function useItemDemand(id: string) {
  return useQuery({
    queryKey: queryKeys.items.demand(id),
    queryFn: () => apiRequest(itemDemandResponseSchema, `/analytics/demand/${id}`),
  });
}
