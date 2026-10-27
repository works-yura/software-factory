import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useApiConfig } from '../api/config';
import { queryKeys } from '../api/keys';
import {
  fetchIntakeBindings,
  fetchIntakeConfig,
  fetchIntakeLabelRoutes,
  saveIntakeBinding,
  saveIntakeConfig,
  saveIntakeLabelRoute,
} from '../ui/domains/factory/services/intake';
import type { IntakeConfig } from '../ui/domains/factory/services/intake';

/** The org's intake source configuration (Settings › Intake). */
export function useIntakeConfigQuery(enabled: boolean = true) {
  const { baseUrl } = useApiConfig();
  return useQuery({
    queryKey: queryKeys.intakeConfig(),
    queryFn: () => fetchIntakeConfig(baseUrl),
    enabled,
  });
}

/**
 * Persist the intake config. On success the config cache is updated in place.
 */
export function useSaveIntakeConfigMutation() {
  const { baseUrl } = useApiConfig();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (config: IntakeConfig) => saveIntakeConfig(baseUrl, config),
    onSuccess: saved => {
      queryClient.setQueryData(queryKeys.intakeConfig(), saved);
    },
  });
}

/** Which Factory project each intake source routes into (org-wide). */
export function useIntakeBindingsQuery(enabled: boolean = true) {
  const { baseUrl } = useApiConfig();
  return useQuery({
    queryKey: queryKeys.intakeBindings(),
    queryFn: () => fetchIntakeBindings(baseUrl),
    enabled,
  });
}

/**
 * Route a source to a Factory project (or clear it).
 */
export function useSaveIntakeBindingMutation() {
  const { baseUrl } = useApiConfig();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (binding: {
      integrationId: string;
      sourceId: string;
      factoryProjectId: string | null;
      board?: string | null;
    }) => saveIntakeBinding(baseUrl, binding),
    onSuccess: bindings => {
      queryClient.setQueryData(queryKeys.intakeBindings(), bindings);
    },
  });
}

/** GitHub label → board routes of one Factory project. */
export function useIntakeLabelRoutesQuery(factoryProjectId: string | undefined) {
  const { baseUrl } = useApiConfig();
  return useQuery({
    queryKey: queryKeys.intakeLabelRoutes(factoryProjectId),
    queryFn: () => fetchIntakeLabelRoutes(baseUrl, factoryProjectId!),
    enabled: Boolean(factoryProjectId),
  });
}

/**
 * Route a label to a board (or clear it with `board: null`). Work items are
 * invalidated because the server relocates cards carrying the label.
 */
export function useSaveIntakeLabelRouteMutation() {
  const { baseUrl } = useApiConfig();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (route: { factoryProjectId: string; integrationId: string; label: string; board: string | null }) =>
      saveIntakeLabelRoute(baseUrl, route),
    onSuccess: (routes, route) => {
      queryClient.setQueryData(queryKeys.intakeLabelRoutes(route.factoryProjectId), routes);
      void queryClient.invalidateQueries({ queryKey: queryKeys.workItems(route.factoryProjectId) });
    },
  });
}
