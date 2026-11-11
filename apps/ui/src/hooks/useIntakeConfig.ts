import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useApiConfig } from '../api/config';
import { queryKeys } from '../api/keys';
import { fetchIntakeConfig, saveIntakeConfig } from '../ui/domains/factory/services/intake';
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
