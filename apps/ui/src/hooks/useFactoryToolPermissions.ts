import { useMutation, useQueryClient } from '@tanstack/react-query';

import { useApiConfig } from '../api/config';
import { queryKeys } from '../api/keys';
import { updateFactoryToolPermissions } from '../ui/domains/workspaces/services/github';
import type { FactoryProjectPayload, FactoryToolPermissions } from '../ui/domains/workspaces/services/github';
import { useFactoryProjectQuery } from './useFactoryDefaultModel';

const NOTHING_SET: FactoryToolPermissions = { categories: {}, yolo: false };

/**
 * The tool permissions of a Factory on Claude Code (Settings → Behavior).
 * Unlike a Factory on Mastra, which keeps them in its agent-controller session,
 * they live on the Factory project itself: a Claude Code Factory has no such
 * session, and the server reads them from the project when it starts a turn.
 * Optimistic on the project query, so the page follows a click at once and a
 * rejection puts it back.
 */
export function useFactoryToolPermissions(factoryProjectId: string | undefined) {
  const { baseUrl } = useApiConfig();
  const queryClient = useQueryClient();
  const projectQuery = useFactoryProjectQuery(factoryProjectId);
  const key = queryKeys.factoryProject(factoryProjectId);
  const mutation = useMutation({
    // One write at a time, so a rollback restores the value before that write.
    scope: { id: `factory-tool-permissions:${factoryProjectId}` },
    mutationFn: (next: FactoryToolPermissions) => updateFactoryToolPermissions(baseUrl, factoryProjectId!, next),
    onMutate: async next => {
      await queryClient.cancelQueries({ queryKey: key, exact: true });
      const previous = queryClient.getQueryData<FactoryProjectPayload>(key);
      if (previous) queryClient.setQueryData<FactoryProjectPayload>(key, { ...previous, toolPermissions: next });
      return { previous };
    },
    onError: (_error, _next, context) => {
      if (context?.previous) queryClient.setQueryData(key, context.previous);
    },
    onSuccess: project => {
      queryClient.setQueryData<FactoryProjectPayload>(key, prev => (prev ? { ...prev, ...project } : project));
    },
  });
  const project = projectQuery.data;
  return {
    /** Undefined until the Factory loads. */
    permissions: project ? (project.toolPermissions ?? NOTHING_SET) : undefined,
    save: mutation.mutateAsync,
  };
}
