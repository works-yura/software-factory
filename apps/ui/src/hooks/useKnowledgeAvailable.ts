import { useHarness } from './useHarness';
import { useServerFeatures } from './useServerFeatures';
import { useFactoryProjectQuery } from './useFactoryDefaultModel';

/**
 * Whether this Factory's Knowledge graph is on offer: the server captures
 * knowledge and the Factory's harness feeds and consults the graph. `pending`
 * holds a direct link until the Factory's harness is known.
 */
export function useKnowledgeAvailable(factoryProjectId: string | undefined) {
  const features = useServerFeatures();
  const project = useFactoryProjectQuery(factoryProjectId);
  const harness = useHarness(project.data?.harness);
  return {
    pending: features.isPending || project.isPending,
    available: features.data?.knowledge === true && harness.supports.knowledge,
  };
}
