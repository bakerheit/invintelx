import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  itemListResponseSchema,
  itemSchema,
  type CreateItemInput,
  type Item,
  type UpdateItemInput,
} from '@invintelx/shared';
import { apiRequest, toQueryString } from '@/lib/api';
import type { TableParams } from '@/hooks/useTableParams';
import { queryKeys } from '@/lib/queryKeys';

/** The list screen's filter state, which is exactly the URL-backed table state. */
export type ItemsQuery = TableParams;

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
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.items.all }),
  });
}

export function useUpdateItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateItemInput }) =>
      apiRequest(itemSchema, `/items/${id}`, { method: 'PATCH', body: input }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.items.all }),
  });
}

export function useArchiveItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (item: Item) =>
      apiRequest(itemSchema, `/items/${item.id}/archive`, { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.items.all }),
  });
}

export function useRestoreItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (item: Item) =>
      apiRequest(itemSchema, `/items/${item.id}/restore`, { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.items.all }),
  });
}
