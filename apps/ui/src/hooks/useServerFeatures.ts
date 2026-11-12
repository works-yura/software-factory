import { useQuery } from '@tanstack/react-query';

import type { HarnessDescriptor } from '@factory/contracts/harnesses';

import { useApiConfig } from '../api/config';
import { queryKeys } from '../api/keys';

export interface ServerFeatures {
  knowledge: boolean;
  /** The server serves its MCP endpoint. Absent from servers that predate it. */
  mcp?: boolean;
  /** The Claude Code harness is configured, so new Factories may run on it. Absent from older servers. */
  claudeCode?: boolean;
  /** The Codex harness runs here (its CLI is installed), so new Factories may run on it. Absent from older servers. */
  codex?: boolean;
  /** Device preview: simulators and emulators on the server's machine (local development). Absent from older servers. */
  device?: boolean;
  /** The harnesses this server runs and what each can do. Absent from older servers. */
  harnesses?: HarnessDescriptor[];
}

export function useServerFeatures() {
  const { client } = useApiConfig();
  return useQuery({
    queryKey: queryKeys.serverFeatures(),
    queryFn: () => client.get<ServerFeatures>('/web/config/features'),
    staleTime: Number.POSITIVE_INFINITY,
  });
}
