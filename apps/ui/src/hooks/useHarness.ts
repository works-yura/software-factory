import { harnessById } from '@factory/contracts';
import type { HarnessDescriptor } from '@factory/contracts';

import { useServerFeatures } from './useServerFeatures';

/**
 * What the harness with this id can do, as the server describes it. Ask this
 * instead of comparing harness ids: a missing or unknown id is Mastra, the
 * harness sessions ran on before there was a choice.
 */
export function useHarness(id: string | null | undefined): HarnessDescriptor {
  const features = useServerFeatures();
  return harnessById(id, features.data?.harnesses);
}
