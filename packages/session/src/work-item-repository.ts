import { SourceControlConnectionNotFoundError } from '@factory/store';
import type { SourceControlStorageHandle } from '@factory/store';
import type { Card } from '@factory/store';

import { resolveEnvironmentRepositories } from './environment-repositories.ts';

export interface EnvironmentRepositoryRef {
  projectRepositoryId: string;
  slug: string;
}

/**
 * Where a card runs. A card that names a repository (an issue's, or one set
 * by hand) resolves to it. A card that names none runs in the whole
 * environment: `environment` lists every environment repository, and
 * `projectRepositoryId` is only the link the session row is filed under
 * (position 1). No repository of the environment is primary to such a card;
 * each one gets the session branch and its own change request.
 */
export type WorkItemRepositoryResolution =
  | { status: 'resolved'; projectRepositoryId: string; slug: string; environment?: EnvironmentRepositoryRef[] }
  | { status: 'unlinked'; hint: string }
  | { status: 'ambiguous'; candidates: string[] };

interface LinkedRepository {
  projectRepositoryId: string;
  externalId: string;
  slug: string;
  inEnvironment: boolean;
}

async function listLinkedRepositories(args: {
  sourceControl: SourceControlStorageHandle;
  orgId: string;
  factoryProjectId: string;
}): Promise<LinkedRepository[]> {
  const { sourceControl, orgId, factoryProjectId } = args;
  const connections = await sourceControl.connections.list({ orgId, factoryProjectId });
  const linked: LinkedRepository[] = [];

  for (const connection of connections.filter(candidate => candidate.integrationId === sourceControl.integrationId)) {
    try {
      const projectRepositories = await sourceControl.projectRepositories.list({ orgId, connectionId: connection.id });
      const repositories = await Promise.all(
        projectRepositories.map(async projectRepository => ({
          projectRepository,
          repository: await sourceControl.repositories.get({ orgId, id: projectRepository.repositoryId }),
        })),
      );
      for (const { projectRepository, repository } of repositories) {
        if (repository) {
          linked.push({
            projectRepositoryId: projectRepository.id,
            externalId: repository.externalId,
            slug: repository.slug,
            inEnvironment: projectRepository.inEnvironment,
          });
        }
      }
    } catch (error) {
      if (!(error instanceof SourceControlConnectionNotFoundError)) throw error;
      // A stale provider connection must not hide healthy linked repositories.
    }
  }

  return linked;
}

function getExternalRepositoryId(integrationId: string, metadata: Record<string, unknown>): string | undefined {
  let id: unknown;
  switch (integrationId) {
    case 'github':
      id = metadata.githubRepositoryId;
      break;
    case 'gitlab':
      id = metadata.gitlabProjectId;
      break;
    default:
      return undefined;
  }
  return id == null ? undefined : String(id);
}

/**
 * The one link among `matches` a run can use. A repository can be linked more
 * than once (a provider-app reinstall adds a second link for the same slug),
 * but only one of those links is in the environment, and only an environment
 * link can start a session, so it wins over its out-of-environment duplicates.
 */
function pickLink(matches: LinkedRepository[]): LinkedRepository | undefined {
  if (matches.length === 1) return matches[0];
  const inEnvironment = matches.filter(repository => repository.inEnvironment);
  return inEnvironment.length === 1 ? inEnvironment[0] : undefined;
}

function findRepositoryBySlug(repositories: LinkedRepository[], slug: string) {
  const matches = repositories.filter(repository => repository.slug === slug);
  return pickLink(matches) ?? matches[0];
}

function resolvedRepository(repository: LinkedRepository): WorkItemRepositoryResolution {
  return { status: 'resolved', projectRepositoryId: repository.projectRepositoryId, slug: repository.slug };
}

export async function resolveWorkItemRepository(args: {
  sourceControl: SourceControlStorageHandle;
  orgId: string;
  factoryProjectId: string;
  item: Pick<Card, 'metadata'> & { workItem: Pick<Card['workItem'], 'metadata'> };
}): Promise<WorkItemRepositoryResolution> {
  const { sourceControl, item } = args;
  const metadata = item.workItem.metadata ?? {};
  const linked = await listLinkedRepositories(args);
  const repositorySignal = typeof item.metadata?.repository === 'string' ? item.metadata.repository : undefined;
  const externalRepositorySignal = getExternalRepositoryId(sourceControl.integrationId, metadata);

  // The provider id survives repository renames, so it outranks a possibly stale slug.
  if (externalRepositorySignal !== undefined) {
    const match = pickLink(linked.filter(repository => repository.externalId === externalRepositorySignal));
    if (match) return resolvedRepository(match);
  }

  if (repositorySignal) {
    const match = findRepositoryBySlug(linked, repositorySignal);
    return match
      ? resolvedRepository(match)
      : { status: 'unlinked', hint: `Repository ${repositorySignal} is not linked to this Factory.` };
  }

  if (externalRepositorySignal !== undefined) {
    return {
      status: 'unlinked',
      hint: `Source-control repository ${externalRepositorySignal} is not linked to this Factory.`,
    };
  }

  const candidates = [...new Set(linked.map(repository => repository.slug))].sort();
  if (candidates.length === 0) {
    return { status: 'unlinked', hint: 'This Factory has no linked source-control repositories.' };
  }
  // Every link shares the one slug here, so prefer the environment link among them.
  const onlyRepository = candidates.length === 1 ? (pickLink(linked) ?? linked[0]) : undefined;
  if (onlyRepository) return resolvedRepository(onlyRepository);
  // Several repositories: the card runs across the environment, none chosen.
  const environment = await resolveEnvironmentRepositories(args);
  const [anchor] = environment;
  if (anchor) {
    return {
      status: 'resolved',
      projectRepositoryId: anchor.link.id,
      slug: anchor.repository.slug,
      environment: environment.map(entry => ({ projectRepositoryId: entry.link.id, slug: entry.repository.slug })),
    };
  }
  return { status: 'ambiguous', candidates };
}

/**
 * Whether a session filed under `projectRepositoryId` can run the card: its
 * own repository, or, for a card spanning the environment, any of it.
 */
export function workItemRunsInLink(
  resolution: Extract<WorkItemRepositoryResolution, { status: 'resolved' }>,
  projectRepositoryId: string,
): boolean {
  return (
    resolution.projectRepositoryId === projectRepositoryId ||
    (resolution.environment ?? []).some(entry => entry.projectRepositoryId === projectRepositoryId)
  );
}
