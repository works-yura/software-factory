import type { LinkedRepositoryPayload } from '../../workspaces/services/github';
import { cardRepositorySlug } from '../boardRepository';

export function useCardRepositorySlug(repositories: LinkedRepositoryPayload[]) {
  return async (source: string, metadata: Record<string, unknown> | undefined) => {
    return cardRepositorySlug(source, metadata, repositories);
  };
}
