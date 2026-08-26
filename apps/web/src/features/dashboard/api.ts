import { useQuery } from '@tanstack/react-query';
import { dashboardResponseSchema, type DashboardQuery } from '@invintelx/shared';
import { apiRequest, toQueryString } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';

/**
 * One request for the whole landing screen.
 *
 * The four lists and both context figures are read from a single pass over the
 * catalogue on the server, so they cannot disagree with each other about what
 * is on the shelf — which four separate queries firing a few hundred
 * milliseconds apart absolutely can.
 */
export function useDashboard(query: Partial<DashboardQuery> = {}) {
  return useQuery({
    queryKey: queryKeys.dashboard(query),
    queryFn: () =>
      apiRequest(dashboardResponseSchema, `/analytics/dashboard${toQueryString({ ...query })}`),
  });
}
