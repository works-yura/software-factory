import { useQuery } from '@tanstack/react-query';

import { useApiConfig } from '../api/config';
import { queryKeys } from '../api/keys';

export interface ServerFeatures {
  knowledge: boolean;
  /** The server serves its MCP endpoint. Absent from servers that predate it. */
  mcp?: boolean;
  /** The Claude Code harness is configured, so new Factories may run on it. Absent from older servers. */
  claudeCode?: boolean;
  /**
   * Claude Code turns with no account fall back to the `claude` login of the machine the server
   * runs on (local development), so nothing has to be added before the first run. Absent from older servers.
   */
  claudeCodeLocalLogin?: boolean;
}

export function useServerFeatures() {
  const { client } = useApiConfig();
  return useQuery({
    queryKey: queryKeys.serverFeatures(),
    queryFn: () => client.get<ServerFeatures>('/web/config/features'),
    staleTime: Number.POSITIVE_INFINITY,
  });
}
