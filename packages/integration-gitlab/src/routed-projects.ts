import { routedSourceScopes } from '@factory/core';
import type { IntakeRoutesReader } from '@factory/core';
import type { SourceControlStorageHandle } from '@factory/store';

import { encodeSourceId, normalizeGitLabHost } from './integration.ts';

/** A GitLab project a Factory project reads: linked to it, and named by one of its intake routes. */
export interface RoutedGitLabProject {
  /** The provider source id (`gitlab-project:…`, host + project id) the GitLab API reads by. */
  sourceId: string;
  /** The project path (`acme/platform/api`), as routes name it. */
  path: string;
  projectId: string;
  host: string;
}

export type RoutedProjectsSourceControl = Pick<
  SourceControlStorageHandle,
  'connections' | 'installations' | 'projectRepositories' | 'repositories'
>;

/**
 * Routes are the one subscription model (ADR-0022): a Factory project reads the GitLab projects it
 * has linked whose path one of its intake routes names (`source.integration = gitlab`,
 * `source.repository = <path>`). A linked project no route names is not read; a route naming a
 * project that isn't linked reads nothing (the GitLab API is reached through the link's connection).
 */
export async function routedGitLabProjects({
  orgId,
  factoryProjectId,
  intakeRoutes,
  sourceControl,
}: {
  orgId: string;
  factoryProjectId: string;
  intakeRoutes: IntakeRoutesReader;
  sourceControl: RoutedProjectsSourceControl;
}): Promise<RoutedGitLabProject[]> {
  const routes = await intakeRoutes.listIntakeRoutes({ orgId, factoryProjectId });
  const named = new Set(routedSourceScopes(routes, 'source.repository', 'gitlab').map(path => path.toLowerCase()));
  if (named.size === 0) return [];
  const projects: RoutedGitLabProject[] = [];
  for (const connection of await sourceControl.connections.list({ orgId, factoryProjectId })) {
    if (connection.integrationId !== 'gitlab') continue;
    const installation = await sourceControl.installations.get({ orgId, id: connection.installationId });
    const rawHost = installation?.providerMetadata.host;
    if (typeof rawHost !== 'string' || !rawHost) continue;
    const host = normalizeGitLabHost(rawHost);
    for (const link of await sourceControl.projectRepositories.list({ orgId, connectionId: connection.id })) {
      const repository = await sourceControl.repositories.get({ orgId, id: link.repositoryId });
      if (!repository || !named.has(repository.slug.toLowerCase())) continue;
      projects.push({
        sourceId: encodeSourceId({ host, projectId: repository.externalId }),
        path: repository.slug,
        projectId: repository.externalId,
        host,
      });
    }
  }
  return projects;
}

/** Whether the Factory project reads the GitLab project at `path` (see {@link routedGitLabProjects}). */
export async function readsGitLabProject(input: {
  orgId: string;
  factoryProjectId: string;
  path: string;
  intakeRoutes: IntakeRoutesReader;
}): Promise<boolean> {
  const routes = await input.intakeRoutes.listIntakeRoutes({ orgId: input.orgId, factoryProjectId: input.factoryProjectId });
  return routedSourceScopes(routes, 'source.repository', 'gitlab').some(
    path => path.toLowerCase() === input.path.toLowerCase(),
  );
}
