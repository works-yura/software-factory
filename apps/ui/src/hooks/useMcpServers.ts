import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useApiConfig } from '../api/config';
import {
  checkMcpServer,
  deleteMcpServer,
  fetchMcpServers,
  saveMcpServer,
} from '../ui/domains/settings/services/mcpServers';
import type { McpServerInput } from '../ui/domains/settings/services/mcpServers';

const key = (baseUrl: string) => ['mcp-servers', baseUrl] as const;

/** The organization's MCP servers, the built-in presets and whether this person may edit them. */
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
  };
}
