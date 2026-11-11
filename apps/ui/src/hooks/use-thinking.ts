import type { ThinkingLevelSetting } from '@mastra/code-sdk/thinking';
import { useQuery } from '@tanstack/react-query';

import { useApiConfig } from '../api/config';
import { queryKeys } from '../api/keys';
import { fetchFactoryProject } from '../ui/domains/workspaces/services/github';
import type { FactoryProjectPayload } from '../ui/domains/workspaces/services/github';

const DEFAULT_THINKING_LEVEL: ThinkingLevelSetting = 'medium';

/**
 * The Factory's thinking default for Mastra sessions — the `effort` of its Mastra default model,
 * what a session uses until it picks its own level. Read off the Factory project, sharing its cache
 * entry; set in Settings → Models with the Mastra default model.
 */
export function useFactoryThinkingDefaultQuery(
  factoryProjectId: string | undefined,
  { enabled = true }: { enabled?: boolean } = {},
) {
  const { baseUrl } = useApiConfig();
  return useQuery({
    queryKey: queryKeys.factoryProject(factoryProjectId),
    queryFn: () => fetchFactoryProject(baseUrl, factoryProjectId!),
    enabled: enabled && !!factoryProjectId,
    select: (project: FactoryProjectPayload) => project.defaultThinkingLevel ?? DEFAULT_THINKING_LEVEL,
  });
}
