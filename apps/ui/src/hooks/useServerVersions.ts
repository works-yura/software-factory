import { useQuery } from '@tanstack/react-query';

import type { HarnessExecutableReport } from '@factory/harness/executable';

import { useApiConfig } from '../api/config';
import { queryKeys } from '../api/keys';
import { requestJson } from '../ui/domains/factory/services/request';

export interface ServerVersions {
  /** Mastra packages the server was built with. Empty when its build shipped no packages manifest. */
  packages: Array<{ name: string; version: string }>;
  nodeVersion: string;
  /** The CLIs the server's harnesses spawn (ADR-0038); absent from servers that predate it. */
  harnessExecutables?: HarnessExecutableReport[];
}

export function useServerVersions() {
  const { baseUrl } = useApiConfig();
  return useQuery({
    queryKey: queryKeys.serverVersions(),
    queryFn: () => requestJson<ServerVersions>(`${baseUrl}/web/config/versions`),
  });
}
