import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useApiConfig } from '../api/config';
import { queryKeys } from '../api/keys';
import {
  connectGithubToken,
  disconnectGithubConnection,
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
      mutationFn: (id: string) => disconnectGithubConnection(baseUrl, id),
      onSuccess: refresh,
    }),
  };
}
