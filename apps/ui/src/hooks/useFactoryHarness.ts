import { useMutation, useQueryClient } from '@tanstack/react-query';

import { useApiConfig } from '../api/config';
import { queryKeys } from '../api/keys';
import { updateFactoryHarness } from '../ui/domains/workspaces/services/github';
import type { ClaudeCodeModel, FactoryHarness, FactoryProjectPayload } from '../ui/domains/workspaces/services/github';

/**
 * Switch the harness new sessions of this Factory start on, or its Claude Code
 * model. Optimistic on the Factory project (`useFactoryProjectQuery`'s cache
 * entry), so every view of it follows the switch at once and a rejection puts
 * it back; the Factory list is refreshed too, since it carries the harness.
 */
export function useSetFactoryHarnessMutation(factoryProjectId: string | undefined) {
  const { baseUrl } = useApiConfig();
  const queryClient = useQueryClient();
  const key = queryKeys.factoryProject(factoryProjectId);
  return useMutation({
    // One write at a time, so a rollback restores the value before that write.
    scope: { id: `factory-harness:${factoryProjectId}` },
    mutationFn: (patch: { harness?: FactoryHarness; claudeCodeModel?: ClaudeCodeModel | null }) =>
      updateFactoryHarness(baseUrl, factoryProjectId!, patch),
    onMutate: async patch => {
      await queryClient.cancelQueries({ queryKey: key, exact: true });
      const previous = queryClient.getQueryData<FactoryProjectPayload>(key);
      if (previous) queryClient.setQueryData<FactoryProjectPayload>(key, { ...previous, ...patch });
      return { previous };
    },
    onError: (_error, _patch, context) => {
      if (context?.previous) queryClient.setQueryData(key, context.previous);
    },
    onSuccess: project => {
      queryClient.setQueryData<FactoryProjectPayload>(key, prev => (prev ? { ...prev, ...project } : project));
      void queryClient.invalidateQueries({ queryKey: queryKeys.factories() });
    },
  });
}
