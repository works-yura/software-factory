import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useApiConfig } from '../api/config';
import {
  checkMcpServer,
  checkMcpServerDraft,
  deleteMcpServer,
  discoverMcpChoices,
  fetchMcpServers,
  fetchMcpSuggestions,
  saveMcpServer,
} from '../ui/domains/settings/services/mcpServers';
import type { McpDiscoveryRequest, McpServerInput } from '../ui/domains/settings/services/mcpServers';

const key = (baseUrl: string) => ['mcp-servers', baseUrl] as const;

/** The organization's MCP servers, the catalog, the accounts inputs can use, and whether this person may edit them. */
export function useMcpServersQuery() {
  const { baseUrl } = useApiConfig();
  return useQuery({ queryKey: key(baseUrl), queryFn: () => fetchMcpServers(baseUrl) });
}

export function useMcpServerMutations() {
  const { baseUrl } = useApiConfig();
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: key(baseUrl) });
  return {
    save: useMutation({ mutationFn: (input: McpServerInput & { id?: string }) => saveMcpServer(baseUrl, input), onSuccess: refresh }),
    remove: useMutation({ mutationFn: (id: string) => deleteMcpServer(baseUrl, id), onSuccess: refresh }),
    check: useMutation({ mutationFn: (id: string) => checkMcpServer(baseUrl, id) }),
    /** «Перевірити» on the form as it is, saved or not. */
    checkDraft: useMutation({ mutationFn: (body: { id?: string; server: McpServerInput }) => checkMcpServerDraft(baseUrl, body) }),
  };
}

/** What a Factory's own bindings suggest for catalog inputs (its Google Cloud project). */
export function useMcpSuggestions(factoryProjectId: string | undefined) {
  const { baseUrl } = useApiConfig();
  return useQuery({
    queryKey: ['mcp-servers', 'suggestions', baseUrl, factoryProjectId] as const,
    queryFn: () => fetchMcpSuggestions(baseUrl, factoryProjectId!),
    enabled: Boolean(factoryProjectId),
  });
}

/** Choices for one catalog input, looked up with the account it depends on; idle until one is picked. */
export function useMcpDiscovery(request: McpDiscoveryRequest | undefined) {
  const { baseUrl } = useApiConfig();
  return useQuery({
    queryKey: ['mcp-servers', 'discover', baseUrl, request] as const,
    queryFn: () => discoverMcpChoices(baseUrl, request!),
    enabled: Boolean(request),
    staleTime: 60_000,
  });
}
