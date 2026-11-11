import type { ProviderOptionSelection } from '@factory/harness/models/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useApiConfig } from '../api/config';
import { queryKeys } from '../api/keys';
import {
  applyFactoryModelDefault,
  clearFactoryModelDefault,
  fetchFactoryProject,
  setFactoryModelDefault,
} from '../ui/domains/workspaces/services/github';
import type { FactoryProjectPayload } from '../ui/domains/workspaces/services/github';

/**
 * The Factory project, with its default model per harness instance (`harnessModelDefaults`).
 * Server state on the `factory_projects` row — not browser/session state — so the hooks below are
 * keyed by `factoryProjectId`.
 */
export function useFactoryProjectQuery(factoryProjectId: string | undefined) {
  const { baseUrl } = useApiConfig();
  return useQuery({
    queryKey: queryKeys.factoryProject(factoryProjectId),
    queryFn: () => fetchFactoryProject(baseUrl, factoryProjectId!),
    enabled: !!factoryProjectId,
  });
}

/** What a default-model write changes: the project and every catalog that reports its defaults. */
function useAfterModelDefaultWrite(factoryProjectId: string | undefined) {
  const queryClient = useQueryClient();
  return (project: FactoryProjectPayload) => {
    queryClient.setQueryData(queryKeys.factoryProject(factoryProjectId), project);
    // Session catalogs report their Factory's defaults too, so every catalog is refreshed.
    void queryClient.invalidateQueries({ queryKey: queryKeys.availableModels() });
  };
}

/** Sets (`selection`) or clears (`null`: the catalog default) one harness instance's Factory default. */
export function useSetFactoryModelDefaultMutation(factoryProjectId: string | undefined) {
  const { baseUrl } = useApiConfig();
  const afterWrite = useAfterModelDefaultWrite(factoryProjectId);
  return useMutation({
    mutationFn: ({
      instanceId,
      selection,
    }: {
      instanceId: string;
      selection: { model: string; options?: ReadonlyArray<ProviderOptionSelection> | undefined } | null;
    }) =>
      selection
        ? setFactoryModelDefault(baseUrl, factoryProjectId!, instanceId, selection)
        : clearFactoryModelDefault(baseUrl, factoryProjectId!, instanceId),
    onSuccess: afterWrite,
  });
}

/** Moves the Factory's running sessions of one instance onto its default, for a harness that can. */
export function useApplyFactoryModelDefaultMutation(factoryProjectId: string) {
  const { baseUrl } = useApiConfig();
  return useMutation({
    mutationFn: (instanceId: string) => applyFactoryModelDefault(baseUrl, factoryProjectId, instanceId),
  });
}
