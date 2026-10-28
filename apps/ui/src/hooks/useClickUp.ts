import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useApiConfig } from '../api/config';
import { queryKeys } from '../api/keys';
import { fetchClickUpLists, fetchClickUpStatus, saveClickUpSettings } from '../ui/domains/factory/services/clickup';

export function useClickUpStatusQuery() {
  const { baseUrl } = useApiConfig();
  return useQuery({
    queryKey: queryKeys.clickupStatus(baseUrl),
    queryFn: () => fetchClickUpStatus(baseUrl),
  });
}

/** Lists the token can see; only fetched once the server reports a working token. */
export function useClickUpListsQuery(enabled: boolean) {
  const { baseUrl } = useApiConfig();
  return useQuery({
    queryKey: queryKeys.clickupLists(baseUrl),
    queryFn: () => fetchClickUpLists(baseUrl),
    enabled,
  });
}

export function useSaveClickUpSettingsMutation() {
  const { baseUrl } = useApiConfig();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (settings: { autoStart: boolean }) => saveClickUpSettings(baseUrl, settings),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.clickupStatus(baseUrl) }),
  });
}
