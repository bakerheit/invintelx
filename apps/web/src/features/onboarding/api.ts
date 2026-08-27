import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  demoDataResultSchema,
  demoRemovalResultSchema,
  onboardingStateSchema,
  type DemoDataResult,
  type DemoRemovalResult,
} from '@invintelx/shared';
import { apiRequest } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';

/**
 * How much is in this instance, and whether any of it is the demo dataset.
 *
 * Every screen that can be empty asks this, so it is cached rather than
 * refetched per mount — the answer changes when somebody imports, loads the
 * demo, or wipes it, and all three invalidate it below.
 */
export function useOnboarding() {
  return useQuery({
    queryKey: queryKeys.onboarding,
    queryFn: () => apiRequest(onboardingStateSchema, '/onboarding'),
  });
}

/**
 * Loading or wiping the demo rewrites the whole catalogue and the whole ledger,
 * so there is no cached list, detail or dashboard left that is still true.
 */
export function useLoadDemoData() {
  const queryClient = useQueryClient();
  return useMutation<DemoDataResult, Error, void>({
    mutationFn: () => apiRequest(demoDataResultSchema, '/onboarding/demo', { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries(),
  });
}

/**
 * The wipe answers with more than the load does: it also says how many demo
 * locations and suppliers it kept because real data had come to rest on them.
 */
export function useRemoveDemoData() {
  const queryClient = useQueryClient();
  return useMutation<DemoRemovalResult, Error, void>({
    mutationFn: () => apiRequest(demoRemovalResultSchema, '/onboarding/demo', { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries(),
  });
}
