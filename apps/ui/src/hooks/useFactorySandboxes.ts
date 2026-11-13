import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useApiConfig } from '../api/config';
import { queryKeys } from '../api/keys';
import { listSandboxes, sleepSandbox } from '../ui/domains/workspaces/services/sandboxes';

/** How often the list refreshes while it is on screen: sandboxes wake and sleep on their own. */
const SANDBOXES_POLL_MS = 30_000;

export function useFactorySandboxesQuery(factoryId: string | undefined) {
  const { baseUrl } = useApiConfig();
  return useQuery({
    queryKey: queryKeys.factorySandboxes(factoryId),
    queryFn: () => listSandboxes(baseUrl, factoryId!),
    enabled: Boolean(factoryId),
    refetchInterval: SANDBOXES_POLL_MS,
    retry: false,
  });
}

export function useSleepSandboxMutation() {
  const { baseUrl } = useApiConfig();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ factoryId, key }: { factoryId: string; key: string }) => sleepSandbox(baseUrl, factoryId, key),
    onSettled: (_result, _error, { factoryId }) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.factorySandboxes(factoryId) });
    },
  });
}
