import { createHash } from 'node:crypto';

import { catchesEveryNewCard, DEFAULT_BOARD_ID, routedSourceScopes } from '@factory/core';
import type { IntakeRoute } from '@factory/core';
import { decodeSourceId, normalizeGitLabHost } from '@factory/integration-gitlab';
import type {
  FactoryProjectsStorage,
  IntakeStorage,
  SourceControlStorageHandle,
  StoredBoardsStorage,
  StoredIntakeRouteInput,
} from '@factory/store';

/** The actor on routes Factory writes for a repository a project reads. */
export const REPOSITORY_SUBSCRIPTION_ACTOR = 'system:repository-subscription';

const HOST_NAMES: Readonly<Record<string, string>> = { github: 'GitHub', gitlab: 'GitLab' };

/** The code hosts whose linked repositories a project reads through repository routes. */
export const REPOSITORY_HOSTS: readonly string[] = Object.keys(HOST_NAMES);

/**
 * The fixed id of the route subscribing a project to a repository: the same on every replica and
 * every run, so the route is written once (the id is the routes table's primary key).
 */
export function repositoryRouteId(orgId: string, factoryProjectId: string, integrationId: string, repository: string): string {
  const hex = createHash('sha256')
    .update(`repository-route\u0000${orgId}\u0000${factoryProjectId}\u0000${integrationId}\u0000${repository.toLowerCase()}`)
    .digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * The route that subscribes a project to a code host repository: the source and the repository
 * (`source.repository`), placing its new cards where the project's catch-all route would have —
 * so adding it changes what the project reads, not where a card lands.
 */
export function repositoryRouteInput(
  integrationId: string,
  repository: string,
  target: StoredIntakeRouteInput['target'],
): StoredIntakeRouteInput {
  const generatedName = `${HOST_NAMES[integrationId] ?? integrationId}: ${repository}`;
  return {
    name: generatedName,
    when: {
      operator: 'AND',
      conditions: [
        { field: 'source.integration', operator: 'equals', value: integrationId },
        { field: 'source.repository', operator: 'equals', value: repository },
      ],
    },
    target,
    origin: { kind: 'repository', integrationId, repository, generatedName },
  };
}

type RoutesWriter = Pick<StoredBoardsStorage, 'listIntakeRoutes' | 'createIntakeRoute'>;

/**
 * Subscribes the project to `repository` unless a route already names it for this host. The new
 * route goes just ahead of the catch-all and takes its target (the default board's first phase
 * when there is none). Idempotent on every replica (fixed id). Returns whether it added a route.
 */
export async function subscribeRepository({
  boards,
  scope,
  integrationId,
  repository,
  actor = REPOSITORY_SUBSCRIPTION_ACTOR,
}: {
  boards: RoutesWriter;
  scope: { orgId: string; factoryProjectId: string };
  integrationId: string;
  repository: string;
  actor?: string;
}): Promise<boolean> {
  const routes = (await boards.listIntakeRoutes(scope)) as unknown as IntakeRoute[];
  const named = routedSourceScopes(routes, 'source.repository', integrationId).map(slug => slug.toLowerCase());
  if (named.includes(repository.toLowerCase())) return false;
  const catchAll = routes.find(catchesEveryNewCard);
  const target = catchAll
    ? { boardKey: catchAll.target.boardKey, phaseKey: catchAll.target.phaseKey ?? null }
    : { boardKey: DEFAULT_BOARD_ID, phaseKey: null };
  await boards.createIntakeRoute(scope, repositoryRouteInput(integrationId, repository, target), actor, {
    id: repositoryRouteId(scope.orgId, scope.factoryProjectId, integrationId, repository),
  });
  return true;
}

/**
 * Before routes were the one subscription model (ADR-0022), the org-wide GitHub intake selection
 * (`sourceIds`: repository ids or full names) said which linked repositories a project read: its
 * board browsed their issues, and in token mode the sweep filed them. Each linked GitHub repository
 * the selection names becomes a route of its project (see `subscribeRepository`), so the project
 * reads exactly what it read before. The `enabled` switch stays the org's on/off for GitHub intake.
 * Idempotent: a repository a route already names gets nothing new.
 */
export async function migrateGithubRepositorySelections({
  projects,
  intake,
  sourceControl,
  boards,
}: {
  projects: Pick<FactoryProjectsStorage, 'listAll'>;
  intake: Pick<IntakeStorage, 'getConfig'>;
  sourceControl: Pick<SourceControlStorageHandle, 'connections'>;
  boards: RoutesWriter;
}): Promise<{ routes: number }> {
  let added = 0;
  const byOrg = new Map<string, string[]>();
  for (const project of await projects.listAll()) {
    byOrg.set(project.orgId, [...(byOrg.get(project.orgId) ?? []), project.id]);
  }
  for (const [orgId, factoryProjectIds] of byOrg) {
    const selection = (await intake.getConfig({ orgId, integrationIds: ['github'] })).github;
    const selected = (selection?.sourceIds ?? []).map(id => id.toLowerCase());
    if (selected.length === 0) continue;
    const connections = await sourceControl.connections.listWithRepositories({ orgId, factoryProjectIds });
    for (const connection of connections) {
      for (const link of connection.repositories) {
        const slug = link.repository?.slug;
        if (!slug) continue;
        if (!selected.includes(link.repositoryId.toLowerCase()) && !selected.includes(slug.toLowerCase())) continue;
        const subscribed = await subscribeRepository({
          boards,
          scope: { orgId, factoryProjectId: connection.factoryProjectId },
          integrationId: 'github',
          repository: slug,
        });
        if (subscribed) added += 1;
      }
    }
  }
  return { routes: added };
}

/**
 * A repository just linked to a project, read from now on: its route is added for the link's code
 * host (`sourceControl` is that host's partition). Returns whether a route was added.
 */
export async function subscribeLinkedRepository({
  orgId,
  integrationId,
  projectRepository,
  sourceControl,
  boards,
}: {
  orgId: string;
  integrationId: string;
  projectRepository: { connectionId: string; repositoryId: string };
  sourceControl: Pick<SourceControlStorageHandle, 'connections' | 'repositories'>;
  boards: RoutesWriter;
}): Promise<boolean> {
  const connection = await sourceControl.connections.get({ orgId, id: projectRepository.connectionId });
  if (!connection || connection.integrationId !== integrationId) return false;
  const repository = await sourceControl.repositories.get({ orgId, id: projectRepository.repositoryId });
  if (!repository) return false;
  return subscribeRepository({
    boards,
    scope: { orgId, factoryProjectId: connection.factoryProjectId },
    integrationId,
    repository: repository.slug,
  });
}

/**
 * Before routes were the one subscription model (ADR-0022), a GitLab project fed a Factory project
 * when the org-wide GitLab selection (`sourceIds`: opaque `gitlab-project:…` ids, host + project id,
 * or the older connection + project id + path form) named it AND a binding pointed it at that
 * Factory project. Each such pair whose GitLab project is linked to the Factory project becomes a
 * route on the project path (see `subscribeRepository`), so the project reads what it read before.
 * A selected, bound project that is not linked had no GitLab connection to be read through and gets
 * nothing. Idempotent: a project a route already names gets nothing new.
 */
export async function migrateGitLabProjectSelections({
  projects,
  intake,
  sourceControl,
  boards,
}: {
  projects: Pick<FactoryProjectsStorage, 'listAll'>;
  intake: Pick<IntakeStorage, 'getConfig' | 'listBindings'>;
  sourceControl: Pick<SourceControlStorageHandle, 'connections' | 'installations' | 'projectRepositories' | 'repositories'>;
  boards: RoutesWriter;
}): Promise<{ routes: number }> {
  let added = 0;
  const orgIds = new Set((await projects.listAll()).map(project => project.orgId));
  for (const orgId of orgIds) {
    const selected = new Set((await intake.getConfig({ orgId, integrationIds: ['gitlab'] })).gitlab?.sourceIds ?? []);
    if (selected.size === 0) continue;
    for (const binding of await intake.listBindings({ orgId, integrationId: 'gitlab' })) {
      if (!selected.has(binding.sourceId)) continue;
      const reference = decodeSourceId(binding.sourceId);
      if (!reference) continue;
      const scope = { orgId, factoryProjectId: binding.factoryProjectId };
      for (const connection of await sourceControl.connections.list(scope)) {
        if (connection.integrationId !== 'gitlab') continue;
        const installation = await sourceControl.installations.get({ orgId, id: connection.installationId });
        const host = installation?.providerMetadata.host;
        if (reference.host && (typeof host !== 'string' || normalizeGitLabHost(host) !== normalizeGitLabHost(reference.host))) {
          continue;
        }
        for (const link of await sourceControl.projectRepositories.list({ orgId, connectionId: connection.id })) {
          const repository = await sourceControl.repositories.get({ orgId, id: link.repositoryId });
          if (!repository || repository.externalId !== reference.projectId) continue;
          const subscribed = await subscribeRepository({
            boards,
            scope,
            integrationId: 'gitlab',
            repository: repository.slug,
          });
          if (subscribed) added += 1;
        }
      }
    }
  }
  return { routes: added };
}
