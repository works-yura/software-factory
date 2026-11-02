import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useApiConfig } from '../api/config';
import { queryKeys } from '../api/keys';
import type { FactorySkillInfo, FactorySkillsResponse } from '../api/types';

/**
 * The catalog of Factory skills — the stage playbooks (triage, plan, review,
 * …) Factory runs follow and the app's own skills. With a Factory project it
 * shows that project's edits and whether the caller may edit them.
 * Mirrors `GET /web/factory/skills`.
 */
export function useFactorySkillsQuery(factoryProjectId?: string) {
  const { client } = useApiConfig();
  const query = factoryProjectId ? `?projectId=${encodeURIComponent(factoryProjectId)}` : '';
  return useQuery({
    queryKey: queryKeys.factorySkills(factoryProjectId),
    queryFn: () => client.get<FactorySkillsResponse>(`/web/factory/skills${query}`),
  });
}

/** Save (`content`) or revert (`content: null`) a project's edit of one skill. */
export function useFactorySkillEditMutation(factoryProjectId: string | undefined) {
  const { client } = useApiConfig();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ name, content }: { name: string; content: string | null }) => {
      const path = `/web/factory/projects/${encodeURIComponent(factoryProjectId!)}/skills/${encodeURIComponent(name)}`;
      return content === null
        ? client.del<{ skill: FactorySkillInfo }>(path)
        : client.put<{ skill: FactorySkillInfo }>(path, { content });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.factorySkills(factoryProjectId) }),
  });
}
