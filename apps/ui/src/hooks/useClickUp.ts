import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useApiConfig } from '../api/config';
import { queryKeys } from '../api/keys';
import {
  fetchClickUpListStatuses,
  fetchClickUpLists,
  fetchClickUpSettings,
  fetchClickUpStatus,
  saveClickUpListRules,
} from '../ui/domains/factory/services/clickup';
import type { ClickUpListRules } from '../ui/domains/factory/services/clickup';

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

export function useClickUpSettingsQuery(enabled: boolean) {
  const { baseUrl } = useApiConfig();
  return useQuery({
    queryKey: queryKeys.clickupSettings(baseUrl),
    queryFn: () => fetchClickUpSettings(baseUrl),
    enabled,
  });
}

/** Statuses a List defines in ClickUp: the rows of its status rules. */
export function useClickUpListStatusesQuery(listId: string) {
  const { baseUrl } = useApiConfig();
  return useQuery({
    queryKey: queryKeys.clickupListStatuses(baseUrl, listId),
    queryFn: () => fetchClickUpListStatuses(baseUrl, listId),
  });
}

export function useSaveClickUpListRulesMutation() {
  const { baseUrl } = useApiConfig();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ listId, rules }: { listId: string; rules: ClickUpListRules }) =>
      saveClickUpListRules(baseUrl, listId, rules),
    onSuccess: settings => queryClient.setQueryData(queryKeys.clickupSettings(baseUrl), settings),
  });
}
