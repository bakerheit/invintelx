import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import {
  countSheetDetailSchema,
  countSheetListResponseSchema,
  movementSchema,
  type CancelCountSheetInput,
  type CreateCountSheetInput,
  type ListCountSheetsQuery,
  type PostCountSheetInput,
  type RecordCountInput,
} from '@invintelx/shared';
import { apiRequest, toQueryString } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';

/** What accepting the variances wrote. The screen shows this, rather than "saved". */
const postedCountSheetSchema = z.object({
  sheet: countSheetDetailSchema,
  movements: z.array(movementSchema),
  balances: z.array(z.number().int()),
});
export type PostedCountSheet = z.infer<typeof postedCountSheetSchema>;

export function useCountSheets(query: Pick<ListCountSheetsQuery, 'page' | 'pageSize' | 'status'>) {
  return useQuery({
    queryKey: queryKeys.counts.list(query),
    queryFn: () => apiRequest(countSheetListResponseSchema, `/counts${toQueryString({ ...query })}`),
    placeholderData: (previous) => previous,
  });
}

export function useCountSheet(id: string) {
  return useQuery({
    queryKey: queryKeys.counts.detail(id),
    queryFn: () => apiRequest(countSheetDetailSchema, `/counts/${id}`),
    enabled: id.length > 0,
  });
}

/**
 * A count changes only the sheet, so only the sheet is invalidated. Accepting
 * the variances is the write that moves stock, and that one reaches wider.
 */
function invalidateSheets(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: queryKeys.counts.all });
}

export function useCreateCountSheet() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateCountSheetInput) =>
      apiRequest(countSheetDetailSchema, '/counts', { method: 'POST', body: input }),
    onSuccess: () => invalidateSheets(queryClient),
  });
}

export function useRecordCount(sheetId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ lineId, ...input }: RecordCountInput & { lineId: string }) =>
      apiRequest(countSheetDetailSchema, `/counts/${sheetId}/lines/${lineId}`, {
        method: 'PATCH',
        body: input,
      }),
    onSuccess: (sheet) => {
      // The response is the whole sheet, so seed the cache with it rather than
      // refetching what the server just sent back. Only the lists are stale.
      queryClient.setQueryData(queryKeys.counts.detail(sheetId), sheet);
      return queryClient.invalidateQueries({ queryKey: queryKeys.counts.lists });
    },
  });
}

export function usePostCountSheet(sheetId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: PostCountSheetInput) =>
      apiRequest(postedCountSheetSchema, `/counts/${sheetId}/post`, {
        method: 'POST',
        body: input,
      }),
    onSuccess: (result) => {
      queryClient.setQueryData(queryKeys.counts.detail(sheetId), result.sheet);
      // Adjustments were written, so every stock figure on every screen is stale.
      return Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.counts.lists }),
        queryClient.invalidateQueries({ queryKey: queryKeys.items.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.movements.all }),
      ]).then(() => undefined);
    },
  });
}

export function useCancelCountSheet(sheetId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CancelCountSheetInput) =>
      apiRequest(countSheetDetailSchema, `/counts/${sheetId}/cancel`, {
        method: 'POST',
        body: input,
      }),
    onSuccess: (sheet) => {
      queryClient.setQueryData(queryKeys.counts.detail(sheetId), sheet);
      return queryClient.invalidateQueries({ queryKey: queryKeys.counts.lists });
    },
  });
}
