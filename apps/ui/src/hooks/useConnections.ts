import type { ConnectionSettingsValues } from '@factory/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useApiConfig } from '../api/config';
import { queryKeys } from '../api/keys';
import { connectionsApi } from '../ui/domains/settings/connections/api';

/*
 * Settings › Підключення's hooks (ADR-0035), named and split as Mastra's tool-provider hooks
 * (`@mastra/react`: useToolProviders, useAllConnections, useAuthorize, useUpdateConnection,
 * useDisconnectConnection), plus Factory's own: reconnect, unlink, removal impact and detail.
 */

/** A connection's change can reach anything read through it (repositories, intake, MCP), so every query on screen refetches. */
function useRefreshAll() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries();
}

/** «Активність»: the Factory's agent calls through every connector that keeps them, in the last `hours`. */
export function useConnectionActivity(factoryProjectId: string | undefined, hours = 24) {
  const { baseUrl } = useApiConfig();
  return useQuery({
    queryKey: ['connections', 'activity', factoryProjectId ?? '', hours] as const,
    queryFn: () => connectionsApi.activity(baseUrl, factoryProjectId!, hours),
    enabled: Boolean(factoryProjectId),
    refetchInterval: 60_000,
  });
}

/** Every connector with its connect methods, capabilities and health, for «Додати підключення». */
export function useConnectors(enabled: boolean = true) {
  const { baseUrl } = useApiConfig();
  return useQuery({ queryKey: queryKeys.connectors(), queryFn: () => connectionsApi.connectors(baseUrl), enabled });
}

/** The Factory's connections from every connector, as the server describes them. */
export function useAllConnections(factoryProjectId: string | undefined) {
  const { baseUrl } = useApiConfig();
  return useQuery({
    queryKey: queryKeys.connections(factoryProjectId ?? ''),
    queryFn: () => connectionsApi.list(baseUrl, factoryProjectId!),
    enabled: Boolean(factoryProjectId),
  });
}

/** Connect through a connector's method: an `authorize` result is a URL to open, a form's the connection it made. */
export function useAuthorize() {
  const { baseUrl } = useApiConfig();
  const refresh = useRefreshAll();
  return useMutation({
    mutationFn: (args: { connector: string; method: string; input: Record<string, string> }) => connectionsApi.connect(baseUrl, args),
    onSuccess: refresh,
  });
}

/** Reconnect a connection through the method its `actions.reconnect` names. */
export function useReconnect() {
  const { baseUrl } = useApiConfig();
  const refresh = useRefreshAll();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: Record<string, string> }) => connectionsApi.reconnect(baseUrl, id, input),
    onSuccess: refresh,
  });
}

/** Rename a connection (its `label`). */
export function useUpdateConnection() {
  const { baseUrl } = useApiConfig();
  const refresh = useRefreshAll();
  return useMutation({
    mutationFn: ({ id, label }: { id: string; label: string }) => connectionsApi.rename(baseUrl, id, label),
    onSuccess: refresh,
  });
}

/** Delete a connection, after its removal impact was shown (`confirm` when something depends on it). */
export function useDisconnectConnection() {
  const { baseUrl } = useApiConfig();
  const refresh = useRefreshAll();
  return useMutation({
    mutationFn: ({ id, confirm }: { id: string; confirm: boolean }) => connectionsApi.remove(baseUrl, id, confirm),
    onSuccess: refresh,
  });
}

/** Drop this Factory's link and keep the organization's account. */
export function useUnlinkConnection() {
  const { baseUrl } = useApiConfig();
  const refresh = useRefreshAll();
  return useMutation({ mutationFn: (id: string) => connectionsApi.unlink(baseUrl, id), onSuccess: refresh });
}

/** Save a `settings` section of a connection's page. */
export function useUpdateConnectionSettings() {
  const { baseUrl } = useApiConfig();
  const refresh = useRefreshAll();
  return useMutation({
    mutationFn: ({ id, section, values }: { id: string; section: string; values: ConnectionSettingsValues }) =>
      connectionsApi.updateSettings(baseUrl, id, section, values),
    onSuccess: refresh,
  });
}

/** What removing a connection would do; read fresh each time the dialog opens. */
export function useConnectionImpact(id: string) {
  const { baseUrl } = useApiConfig();
  return useQuery({ queryKey: queryKeys.connectionImpact(id), queryFn: () => connectionsApi.impact(baseUrl, id), staleTime: 0, gcTime: 0 });
}

/** A connection's detail sections. */
export function useConnectionDetail(id: string) {
  const { baseUrl } = useApiConfig();
  return useQuery({ queryKey: queryKeys.connectionDetail(id), queryFn: () => connectionsApi.detail(baseUrl, id) });
}
