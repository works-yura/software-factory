import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useApiConfig } from '../api/config';
import { queryKeys } from '../api/keys';
import {
  connectClickUp,
  disconnectClickUp,
  fetchClickUpLists,
  fetchClickUpListStatuses,
  fetchClickUpStatus,
} from '../ui/domains/factory/services/clickup';

export function useClickUpStatusQuery() {
  const { baseUrl } = useApiConfig();
  return useQuery({
    queryKey: queryKeys.clickupStatus(baseUrl),
    queryFn: () => fetchClickUpStatus(baseUrl),
  });
}

/** A List's statuses, for a route's «Статус» condition; fetched only for a chosen List. */
export function useClickUpListStatusesQuery(listId: string | undefined) {
  const { baseUrl } = useApiConfig();
  return useQuery({
    queryKey: queryKeys.clickupListStatuses(baseUrl, listId ?? ''),
    queryFn: () => fetchClickUpListStatuses(baseUrl, listId!),
    enabled: Boolean(listId),
    retry: false,
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

/**
 * Connect, replace or disconnect the organization's ClickUp token (admins only). The answer is the
 * new status; the Lists the old token saw are read again.
 */
export function useClickUpConnectionMutations() {
  const { baseUrl } = useApiConfig();
  const queryClient = useQueryClient();
  const settle = (status: Awaited<ReturnType<typeof connectClickUp>>) => {
    queryClient.setQueryData(queryKeys.clickupStatus(baseUrl), status);
    void queryClient.invalidateQueries({ queryKey: ['clickup', 'lists'] });
  };
  return {
    connect: useMutation({ mutationFn: (token: string) => connectClickUp(baseUrl, token), onSuccess: settle }),
    disconnect: useMutation({ mutationFn: () => disconnectClickUp(baseUrl), onSuccess: settle }),
  };
}
