import { useQuery } from '@tanstack/react-query';

import { ApiRequestError } from '../api/client';
import { useApiConfig } from '../api/config';
import { queryKeys } from '../api/keys';

export interface ServerStatusProblem {
  code: string;
  /** For `secret_key_mismatch`: no key at all, or a different key than the secrets were written with. */
  reason?: 'missing_key' | 'changed_key';
  title: string;
  message: string;
  /** The one step that fixes it. Env var names are wrapped in backticks. */
  fix?: string;
  docsUrl?: string;
}

export interface ServerStatus {
  problems: ServerStatusProblem[];
}

/**
 * Problems that stop the whole Factory from working. Re-read when the tab
 * regains focus, so a redeploy with a bad key shows up without a reload.
 */
export function useServerStatus() {
  const { client } = useApiConfig();
  return useQuery({
    queryKey: queryKeys.serverStatus(),
    queryFn: () =>
      client.get<ServerStatus>('/web/status').catch((error: unknown): ServerStatus => {
        // Servers that predate the endpoint have nothing to report.
        if (error instanceof ApiRequestError && error.status === 404) return { problems: [] };
        throw error;
      }),
    // A blip on the one read must not hide a real problem until the next reload.
    retry: 3,
    refetchOnWindowFocus: true,
    staleTime: 0,
  });
}
