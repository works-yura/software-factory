import { keepPreviousData, useQuery } from '@tanstack/react-query';

import { useApiConfig } from '../api/config';
import { queryKeys } from '../api/keys';
import type {
  AccountsUsageResponse,
  SessionUsageResponse,
  UsageLimitsResponse,
  UsageSummaryResponse,
  WorkItemsUsageResponse,
} from '../api/types';

/**
 * Each account's allowance windows (5-hour, weekly, model). Opening the view asks the server to read
 * them from the provider again (`refresh=1`); it does so at most once a minute per account.
 */
export function useAccountUsageQuery(provider: string, options: { enabled?: boolean } = {}) {
  const { client } = useApiConfig();
  return useQuery({
    queryKey: queryKeys.accountUsage(provider),
    queryFn: () =>
      client.get<AccountsUsageResponse>(`/web/config/providers/${encodeURIComponent(provider)}/accounts/usage?refresh=1`),
    enabled: options.enabled ?? true,
    refetchOnMount: 'always',
    retry: false,
  });
}

/** How often a view that shows limits reads them again while it stays open (the stored reading; cheap). */
export const USAGE_LIMITS_POLL_MS = 60_000;

/**
 * Every harness's sign-ins with their allowance windows, in one list. `refresh` asks the server to
 * read them from the providers again (at most once a minute per account); without it the stored
 * reading comes back, which running turns keep current.
 */
export function useUsageLimitsQuery(options: { refresh?: boolean; enabled?: boolean } = {}) {
  const { client } = useApiConfig();
  const refresh = options.refresh ?? false;
  return useQuery({
    queryKey: queryKeys.usageLimits(refresh),
    queryFn: () => client.get<UsageLimitsResponse>(`/web/usage/limits${refresh ? '?refresh=1' : ''}`),
    enabled: options.enabled ?? true,
    refetchOnMount: refresh ? 'always' : true,
    refetchInterval: refresh ? false : USAGE_LIMITS_POLL_MS,
    retry: false,
  });
}

export interface UsageSummaryFilter {
  from: string;
  to: string;
  factoryProjectId?: string;
  harnessId?: string;
}

export function useUsageSummaryQuery(filter: UsageSummaryFilter) {
  const { client } = useApiConfig();
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) if (value) params.set(key, value);
  return useQuery({
    queryKey: queryKeys.usageSummary({ ...filter }),
    queryFn: () => client.get<UsageSummaryResponse>(`/web/usage/summary?${params.toString()}`),
    placeholderData: keepPreviousData,
    retry: false,
  });
}

/** A session's turns and total; recorded when each turn ends. */
export function useSessionUsageQuery(sessionId: string | undefined) {
  const { client } = useApiConfig();
  return useQuery({
    queryKey: queryKeys.sessionUsage(sessionId),
    queryFn: () => client.get<SessionUsageResponse>(`/web/usage/sessions/${encodeURIComponent(sessionId!)}`),
    enabled: Boolean(sessionId),
    retry: false,
  });
}

/** Cards' totals and runs. */
export function useWorkItemsUsageQuery(workItemIds: readonly string[], options: { enabled?: boolean } = {}) {
  const { client } = useApiConfig();
  return useQuery({
    queryKey: queryKeys.workItemsUsage(workItemIds),
    queryFn: () =>
      client.get<WorkItemsUsageResponse>(`/web/usage/work-items?ids=${workItemIds.map(encodeURIComponent).join(',')}`),
    enabled: (options.enabled ?? true) && workItemIds.length > 0,
    retry: false,
  });
}
