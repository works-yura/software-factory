import type { LinkedRepositoryPayload } from '../workspaces/services/github';

export function repositoryMatchesCardSource(repository: LinkedRepositoryPayload, source: string) {
  const provider = repository.provider ?? 'github';
  if (source === 'github-issue' || source === 'github-pr') return provider === 'github';
  if (source === 'gitlab-issue' || source === 'gitlab-pr') return provider === 'gitlab';
  return true;
}

function matchesProviderRepositoryId(
  repository: LinkedRepositoryPayload,
  source: string,
  metadata: Record<string, unknown> | undefined,
) {
  if (!repositoryMatchesCardSource(repository, source)) return false;
  const provider = repository.provider ?? 'github';
  const id = provider === 'github' ? metadata?.githubRepositoryId : metadata?.gitlabProjectId;
  return id != null && repository.externalId === String(id);
}

function findUniqueRepositoryByProviderId(
  repositories: LinkedRepositoryPayload[],
  source: string,
  metadata: Record<string, unknown> | undefined,
) {
  const matches = repositories.filter(repository => matchesProviderRepositoryId(repository, source, metadata));
  const [match] = matches;
  return matches.length === 1 ? match : undefined;
}

export function cardRepositorySlug(
  source: string,
  metadata: Record<string, unknown> | undefined,
  repositories: LinkedRepositoryPayload[],
) {
  // The provider id survives repository renames, so it outranks a possibly stale slug.
  const repository = findUniqueRepositoryByProviderId(repositories, source, metadata);
  if (repository) return repository.slug;
  if (typeof metadata?.repository === 'string') return metadata.repository;
  return undefined;
}

/** The linked repository a card's source lives in, else the board's primary repository. */
export function cardProjectRepositoryId(
  repositories: LinkedRepositoryPayload[],
  card: { source: string; metadata?: Record<string, unknown> },
  fallback: string,
) {
  return findUniqueRepositoryByProviderId(repositories, card.source, card.metadata)?.projectRepositoryId ?? fallback;
}

/**
 * The link a card's new session is filed under. A card that names a
 * repository runs in it. A card that names none runs across the environment
 * (every repository the sandbox boots), so nobody picks one: the row goes
 * under the first environment repository, which is only where it is filed.
 */
export function sessionRepositoryFor(
  repositories: LinkedRepositoryPayload[],
  card: { source: string; metadata?: Record<string, unknown> },
):
  | { repository: LinkedRepositoryPayload; namedByCard: boolean }
  | { error: 'none' | 'environment' | 'unlinked'; slug?: string } {
  const compatible = repositories.filter(repository => repositoryMatchesCardSource(repository, card.source));
  if (compatible.length === 0) return { error: 'none' };
  const slug = cardRepositorySlug(card.source, card.metadata, repositories);
  if (slug) {
    const named = compatible.find(repository => repository.slug === slug);
    return named ? { repository: named, namedByCard: true } : { error: 'unlinked', slug };
  }
  const environment = compatible
    .filter(repository => repository.inEnvironment !== false)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const filedUnder = environment[0] ?? (compatible.length === 1 ? compatible[0] : undefined);
  return filedUnder ? { repository: filedUnder, namedByCard: false } : { error: 'environment' };
}
