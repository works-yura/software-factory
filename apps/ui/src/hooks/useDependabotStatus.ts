import { useQuery } from '@tanstack/react-query';

import { useApiConfig } from '../api/config';
import { queryKeys } from '../api/keys';
import { requestJson } from '../ui/domains/factory/services/request';

/** How the last Dependabot sweep went for one repository (`GET /web/github/dependabot/status`). */
export interface DependabotRepositoryStatus {
  repository: string;
  checkedAt: string;
  openAlerts?: number;
  /** Why GitHub refused the alerts: a missing permission, alerts switched off, or no access. */
  problem?: 'permission' | 'disabled' | 'not_found' | 'error';
  message?: string;
}

/** The organization's Dependabot sweep per repository, refreshed every minute while shown. */
export function useDependabotStatusQuery(enabled: boolean) {
  const { baseUrl } = useApiConfig();
  return useQuery({
    queryKey: queryKeys.dependabotStatus(),
    queryFn: async () =>
      (await requestJson<{ repositories: DependabotRepositoryStatus[] }>(`${baseUrl}/web/github/dependabot/status`))
        .repositories,
    enabled,
    refetchInterval: 60_000,
  });
}
