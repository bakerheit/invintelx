import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  demoDataResultSchema,
  onboardingStateSchema,
  type DemoDataResult,
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
function useDemoMutation(method: 'POST' | 'DELETE') {
  const queryClient = useQueryClient();
  return useMutation<DemoDataResult, Error, void>({
    mutationFn: () => apiRequest(demoDataResultSchema, '/onboarding/demo', { method }),
    onSuccess: () => queryClient.invalidateQueries(),
  });
}

export function useLoadDemoData() {
  return useDemoMutation('POST');
}

export function useRemoveDemoData() {
  return useDemoMutation('DELETE');
}
