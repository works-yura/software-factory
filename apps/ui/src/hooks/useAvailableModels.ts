import type { ModelReasoningOption } from '@mastra/core/llm';
import type { ModelCatalogEntry } from '@factory/api/config';
import type { HarnessModelInstanceInfo } from '@factory/harness/models/facet';
import { queryOptions, useQuery } from '@tanstack/react-query';

import { useApiConfig } from '../api/config';
import { queryKeys } from '../api/keys';
import type { AvailableModelsFilter } from '../api/keys';
import { fetchSessionModelCatalog, sessionModelCatalogQueryOptions } from './useSessionModelCatalog';
import type { SessionModelCatalog, SessionModelCatalogTarget } from './useSessionModelCatalog';
import { translator } from '../ui/i18n/t';

const tk = translator('app');

/** One selectable model from `GET /web/config/models` (credentialed providers only). */
export type AvailableModelOption = ModelCatalogEntry;

export interface AvailableModelsTarget extends AvailableModelsFilter {
  enabled?: boolean;
}

interface SettingsModelCatalog {
  models: AvailableModelOption[];
  /** The model a chat starts on while the Factory has no default; null when no key can run it. */
  fallbackModelId?: string | null;
  /** One per harness the server runs, from its model facet; what the model picker reads (`toProviderInstances`). */
  instances?: HarnessModelInstanceInfo[];
}

/** `GET /web/config/models` whole: Mastra's models, the session's or Factory's default, every harness instance. */
export type ModelCatalogResponse = SettingsModelCatalog & { defaultModelId?: string | null };

function settingsModelsQuery(target?: AvailableModelsTarget) {
  if (target?.factoryProjectId) return `?factoryId=${encodeURIComponent(target.factoryProjectId)}`;
  return '';
}

async function fetchSettingsModels(baseUrl: string, target?: AvailableModelsTarget): Promise<SettingsModelCatalog> {
  const query = settingsModelsQuery(target);
  const res = await fetch(`${baseUrl}/web/config/models${query}`, {
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(tk('errors.loadModelsFailed', { status: res.status }));
  return (await res.json()) as SettingsModelCatalog;
}

/** Settings catalogs use the Factory's organization credentials. */
export function availableModelsQueryOptions(baseUrl: string, target?: AvailableModelsTarget) {
  return queryOptions({
    queryKey: queryKeys.availableModels(target && { factoryProjectId: target.factoryProjectId }),
    queryFn: () => fetchSettingsModels(baseUrl, target),
  });
}

export function useAvailableModelsQuery(target?: AvailableModelsTarget) {
  const { baseUrl, client } = useApiConfig();
  const session: SessionModelCatalogTarget | undefined =
    target?.sessionId && target.resourceId && target.threadId
      ? { ...target, sessionId: target.sessionId, resourceId: target.resourceId, threadId: target.threadId }
      : undefined;
  const queryKey = session
    ? sessionModelCatalogQueryOptions(client, session).queryKey
    : availableModelsQueryOptions(baseUrl, target).queryKey;
  return useQuery<SettingsModelCatalog | SessionModelCatalog, Error, AvailableModelOption[]>({
    queryKey,
    queryFn: session ? () => fetchSessionModelCatalog(client, session) : () => fetchSettingsModels(baseUrl, target),
    enabled: target?.enabled !== false,
    select: catalog => catalog.models,
  });
}

/** The whole catalog response, for the model picker's provider instances (`toProviderInstances`). */
export function useModelCatalogQuery(target?: AvailableModelsTarget) {
  const { baseUrl, client } = useApiConfig();
  const session: SessionModelCatalogTarget | undefined =
    target?.sessionId && target.resourceId && target.threadId
      ? { ...target, sessionId: target.sessionId, resourceId: target.resourceId, threadId: target.threadId }
      : undefined;
  const queryKey = session
    ? sessionModelCatalogQueryOptions(client, session).queryKey
    : availableModelsQueryOptions(baseUrl, target).queryKey;
  return useQuery<SettingsModelCatalog | SessionModelCatalog, Error, ModelCatalogResponse>({
    queryKey,
    queryFn: session ? () => fetchSessionModelCatalog(client, session) : () => fetchSettingsModels(baseUrl, target),
    enabled: target?.enabled !== false,
  });
}

/** The server's built-in pick for a chat in a Factory with no default model. */
export function useFallbackModelQuery(target: AvailableModelsTarget) {
  const { baseUrl } = useApiConfig();
  return useQuery({
    ...availableModelsQueryOptions(baseUrl, target),
    enabled: target.enabled !== false,
    select: catalog => catalog.fallbackModelId ?? undefined,
  });
}

export function useModelReasoningOptions(
  modelId: string | undefined,
  target?: AvailableModelsTarget,
): ModelReasoningOption[] | undefined {
  const { data: models } = useAvailableModelsQuery(target);
  return models?.find(model => model.id === modelId)?.reasoningOptions;
}
