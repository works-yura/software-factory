import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useApiConfig } from '../api/config';
import { queryKeys } from '../api/keys';
import {
  createSandboxEnvFile,
  deleteSandboxEnv,
  deleteSandboxEnvFile,
  listSandboxEnvFiles,
  listSandboxEnvs,
  setSandboxEnv,
  setSandboxStages,
  updateSandboxEnvAppliesTo,
  updateSandboxEnvFile,
} from '../ui/domains/workspaces/services/sandbox-envs';
import type {
  SandboxEnvAppliesTo,
  SandboxMaterializableStage,
  SandboxStage,
} from '../ui/domains/workspaces/services/sandbox-envs';

type SandboxEnvInput = { name: string; value: string; appliesTo: SandboxEnvAppliesTo; stage?: SandboxStage };

/** How saving one variable of a batch went; `error` is the server's message. */
export type SandboxEnvSaveResult = { name: string; ok: true } | { name: string; ok: false; error: string };

/** A Factory's sandbox environment variables (names and settings only). Idle without a factory id. */
export function useSandboxEnvsQuery(factoryId: string | undefined) {
  const { baseUrl } = useApiConfig();
  return useQuery({
    queryKey: queryKeys.factorySandboxEnvs(factoryId),
    queryFn: () => listSandboxEnvs(baseUrl, factoryId!),
    enabled: Boolean(factoryId),
  });
}

/** Add, replace, re-scope or delete one variable; each refetches the list. */
export function useSandboxEnvMutations(factoryId: string) {
  const { baseUrl } = useApiConfig();
  const queryClient = useQueryClient();
  const onSuccess = () => queryClient.invalidateQueries({ queryKey: queryKeys.factorySandboxEnvs(factoryId) });
  return {
    set: useMutation({
      mutationFn: (input: SandboxEnvInput) => setSandboxEnv(baseUrl, factoryId, input),
      onSuccess,
    }),
    /**
     * Saves several variables one by one (the API takes one per request) and
     * reports each result; a failure doesn't stop the rest. Refetches once.
     */
    setMany: useMutation({
      mutationFn: async (inputs: SandboxEnvInput[]): Promise<SandboxEnvSaveResult[]> => {
        const results: SandboxEnvSaveResult[] = [];
        for (const input of inputs) {
          try {
            await setSandboxEnv(baseUrl, factoryId, input);
            results.push({ name: input.name, ok: true });
          } catch (error) {
            results.push({ name: input.name, ok: false, error: error instanceof Error ? error.message : String(error) });
          }
        }
        return results;
      },
      onSettled: onSuccess,
    }),
    updateAppliesTo: useMutation({
      mutationFn: (input: { name: string; appliesTo?: SandboxEnvAppliesTo; stage?: SandboxStage }) =>
        updateSandboxEnvAppliesTo(baseUrl, factoryId, input),
      onSuccess,
    }),
    setStages: useMutation({
      mutationFn: (stages: SandboxMaterializableStage[]) => setSandboxStages(baseUrl, factoryId, stages),
      onSuccess,
    }),
    remove: useMutation({
      mutationFn: (name: string) => deleteSandboxEnv(baseUrl, factoryId, name),
      onSuccess,
    }),
  };
}

/** A Factory's env files (paths, stages and sizes; never contents). Idle until `enabled`. */
export function useSandboxEnvFilesQuery(factoryId: string | undefined, enabled = true) {
  const { baseUrl } = useApiConfig();
  return useQuery({
    queryKey: queryKeys.factorySandboxEnvFiles(factoryId),
    queryFn: () => listSandboxEnvFiles(baseUrl, factoryId!),
    enabled: Boolean(factoryId) && enabled,
  });
}

/** Add, edit or delete one env file; each refetches the list. */
export function useSandboxEnvFileMutations(factoryId: string) {
  const { baseUrl } = useApiConfig();
  const queryClient = useQueryClient();
  const onSuccess = () => queryClient.invalidateQueries({ queryKey: queryKeys.factorySandboxEnvFiles(factoryId) });
  return {
    create: useMutation({
      mutationFn: (input: { projectRepositoryId: string; path: string; stage: SandboxStage; content: string }) =>
        createSandboxEnvFile(baseUrl, factoryId, input),
      onSuccess,
    }),
    update: useMutation({
      mutationFn: (input: { id: string; path?: string; stage?: SandboxStage; content?: string }) =>
        updateSandboxEnvFile(baseUrl, factoryId, input),
      onSuccess,
    }),
    remove: useMutation({
      mutationFn: (id: string) => deleteSandboxEnvFile(baseUrl, factoryId, id),
      onSuccess,
    }),
  };
}
