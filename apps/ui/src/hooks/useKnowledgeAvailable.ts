import { useServerFeatures } from './useServerFeatures';
import { useFactoryProjectQuery } from './useFactoryDefaultModel';

/**
 * Whether this Factory's Knowledge graph is on offer. The curator that writes
 * it and the `knowledge_*` tools that read it are Mastra's; a Factory on Claude
 * Code never feeds or consults the graph, so it has no Knowledge to show.
 * `pending` holds a direct link until the Factory's harness is known.
 */
export function useKnowledgeAvailable(factoryProjectId: string | undefined) {
  const features = useServerFeatures();
  const project = useFactoryProjectQuery(factoryProjectId);
  return {
    pending: features.isPending || project.isPending,
    available: features.data?.knowledge === true && project.data?.harness !== 'claude-code',
  };
}
