import { useQuery } from '@tanstack/react-query';
import { actionListResponseSchema, type ActionListQuery } from '@invintelx/shared';
import { apiRequest, toQueryString } from '@/lib/api';

export function useActionList(query: Partial<ActionListQuery> = {}) {
  return useQuery({
    queryKey: ['action-list', query],
    queryFn: () =>
      apiRequest(actionListResponseSchema, `/analytics/action-list${toQueryString({ ...query })}`),
  });
}
