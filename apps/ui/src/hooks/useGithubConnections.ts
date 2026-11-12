import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useApiConfig } from '../api/config';
import { queryKeys } from '../api/keys';
import {
  connectGithubToken,
  disconnectGithubConnection,
  fetchGithubConnectionUsage,
  fetchGithubConnections,
  replaceGithubToken,
} from '../ui/domains/workspaces/services/github';

/** Every GitHub connection of the organization (App installations and tokens), with live repository counts. */
export function useGithubConnectionsQuery(enabled: boolean = true) {
  const { baseUrl } = useApiConfig();
  return useQuery({
    queryKey: queryKeys.githubConnections(),
    queryFn: () => fetchGithubConnections(baseUrl),
    enabled,
  });
}

/** What deleting connection `id` would move or unlink; read when the delete dialog opens. */
export function useGithubConnectionUsageQuery(id: string, enabled: boolean = true) {
  const { baseUrl } = useApiConfig();
  return useQuery({
    queryKey: queryKeys.githubConnectionUsage(id),
    queryFn: () => fetchGithubConnectionUsage(baseUrl, id),
    enabled,
    staleTime: 0,
  });
}

/**
 * Connect, replace and disconnect GitHub tokens and connections. Each success re-reads the status,
 * the connections and the repository lists, since all three change with the organization's connections.
 */
export function useGithubConnectionMutations() {
  const { baseUrl } = useApiConfig();
  const queryClient = useQueryClient();
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.githubStatus() }),
      queryClient.invalidateQueries({ queryKey: queryKeys.githubConnections() }),
      queryClient.invalidateQueries({ queryKey: ['github', 'repos'] }),
      // Moved or unlinked repositories change the Factories' repository lists.
      queryClient.invalidateQueries({ queryKey: ['factory', 'project'] }),
      queryClient.invalidateQueries({ queryKey: ['factory', 'environment'] }),
    ]);
  return {
    connectToken: useMutation({
      mutationFn: (token: string) => connectGithubToken(baseUrl, token),
      onSuccess: refresh,
    }),
    replaceToken: useMutation({
      mutationFn: ({ id, token }: { id: string; token: string }) => replaceGithubToken(baseUrl, id, token),
      onSuccess: refresh,
    }),
    disconnect: useMutation({
      // Only after the dialog showed what moves and what is unlinked (useGithubConnectionUsageQuery).
      mutationFn: (id: string) => disconnectGithubConnection(baseUrl, id, { confirm: true }),
      onSuccess: refresh,
    }),
  };
}
