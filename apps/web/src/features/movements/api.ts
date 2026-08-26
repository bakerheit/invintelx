import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import {
  itemListResponseSchema,
  locationSchema,
  movementListResponseSchema,
  movementSchema,
  paginatedSchema,
  type AdjustInput,
  type IssueInput,
  type ListMovementsQuery,
  type ReceiveInput,
  type ReverseInput,
  type TransferInput,
} from '@invintelx/shared';
import { apiRequest, toQueryString } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';

/** Locations list their own page shape inline on the server; mirror it here. */
const locationListResponseSchema = paginatedSchema(locationSchema);

/**
 * What a write returns: the row, and where the bin landed.
 *
 * The balance rides back with the write rather than being re-read, so the screen
 * shows the consequence of this movement and not whatever the projection says a
 * moment later, once somebody else's movement has also landed.
 *
 * Declared here rather than in `@invintelx/shared` alongside the input schemas,
 * because the API route declares its own copy inline too — see the note on the
 * ticket. Both sides validating the same shape means a drift shows up as a
 * contract mismatch on the client rather than as `undefined` three components in.
 */
const postedMovementSchema = z.object({
  movement: movementSchema,
  balanceAfter: z.number().int(),
});
export type PostedMovement = z.infer<typeof postedMovementSchema>;

/** A transfer lands in two bins, so both balances come back. */
const postedTransferSchema = z.object({
  out: movementSchema,
  in: movementSchema,
  fromBalance: z.number().int(),
  toBalance: z.number().int(),
});
export type PostedTransfer = z.infer<typeof postedTransferSchema>;

/** How many suggestions a picker shows before asking for a narrower search. */
export const PICKER_PAGE_SIZE = 8;

/**
 * Items matching what somebody has typed, for the item picker.
 *
 * Archived items are excluded: the ledger refuses to move stock against one, so
 * offering it as a choice is only a way to reach a rejection.
 */
export function useItemSearch(q: string) {
  return useQuery({
    queryKey: queryKeys.items.list({ q, status: 'active', pageSize: PICKER_PAGE_SIZE }),
    queryFn: () =>
      apiRequest(
        itemListResponseSchema,
        `/items${toQueryString({ q, status: 'active', pageSize: PICKER_PAGE_SIZE, sort: 'sku', order: 'asc' })}`,
      ),
    placeholderData: (previous) => previous,
  });
}

/**
 * Bins matching what somebody has typed.
 *
 * Only bins, because only a leaf holds stock — a picker that offers a zone is
 * offering a choice the ledger will reject.
 */
export function useBinSearch(q: string) {
  return useQuery({
    queryKey: queryKeys.locations.list({ q, type: 'bin', pageSize: PICKER_PAGE_SIZE }),
    queryFn: () =>
      apiRequest(
        locationListResponseSchema,
        `/locations${toQueryString({ q, type: 'bin', pageSize: PICKER_PAGE_SIZE })}`,
      ),
    placeholderData: (previous) => previous,
  });
}

export function useMovements(query: Pick<ListMovementsQuery, 'page' | 'pageSize'>) {
  return useQuery({
    queryKey: queryKeys.movements.list(query),
    queryFn: () =>
      apiRequest(movementListResponseSchema, `/movements${toQueryString({ ...query })}`),
    placeholderData: (previous) => previous,
  });
}

/**
 * Everything a write can have moved.
 *
 * `items` is a prefix over the detail, stock, history and demand keys, so one
 * invalidation reaches the item page a movement was posted from as well as the
 * ledger list — no screen has to know it needs refreshing.
 */
function invalidateAfterWrite(queryClient: QueryClient): Promise<void> {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.items.all }),
    queryClient.invalidateQueries({ queryKey: queryKeys.movements.all }),
  ]).then(() => undefined);
}

export function useReceive() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ReceiveInput) =>
      apiRequest(postedMovementSchema, '/movements/receive', { method: 'POST', body: input }),
    onSuccess: () => invalidateAfterWrite(queryClient),
  });
}

export function useIssue() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: IssueInput) =>
      apiRequest(postedMovementSchema, '/movements/issue', { method: 'POST', body: input }),
    onSuccess: () => invalidateAfterWrite(queryClient),
  });
}

export function useTransfer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: TransferInput) =>
      apiRequest(postedTransferSchema, '/movements/transfer', { method: 'POST', body: input }),
    onSuccess: () => invalidateAfterWrite(queryClient),
  });
}

export function useAdjust() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: AdjustInput) =>
      apiRequest(postedMovementSchema, '/movements/adjust', { method: 'POST', body: input }),
    onSuccess: () => invalidateAfterWrite(queryClient),
  });
}

/** Append the opposite of an earlier movement. The original is never touched. */
export function useReverseMovement() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: ReverseInput }) =>
      apiRequest(postedMovementSchema, `/movements/${id}/reverse`, { method: 'POST', body: input }),
    onSuccess: () => invalidateAfterWrite(queryClient),
  });
}
