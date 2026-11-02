/**
 * The supervisor session: one per factory, addressed by a self-describing
 * resourceId (see `supervisorResourceId` in @factory/session) so a restarted
 * server can recover its scope without a lookup table. The session has no
 * repository, no sandbox and no work-item seat — its tools talk to storage
 * directly.
 */

import type { MastraCodeState } from '@mastra/code-sdk/schema';
import type { AgentController, AgentControllerRequestContext } from '@mastra/core/agent-controller';
import type { RequestContext } from '@mastra/core/request-context';

import { getFactoryAuthOrgId, getFactoryAuthUserFromContext } from '@factory/auth';
import { primeTenantCredentialsForTenant } from '@factory/credentials';
import {
  hydrateFactorySession,
  parseSupervisorResourceId,
  resolveFactorySessionModel,
  supervisorProjectIdFromContext,
} from '@factory/session';
import type { FactoryProjectsStorage } from '@factory/store';

type FactorySession = Awaited<ReturnType<AgentController<MastraCodeState>['createSession']>>;

/** The project a Supervisor session works in. */
export interface SupervisorScope {
  orgId: string;
  factoryProjectId: string;
}

/**
 * Scope a request to a supervisor session the caller is allowed to drive:
 * the resourceId must name a project, and the caller's org must own it.
 * Anything else yields null and the supervisor tools stay unregistered.
 */
export async function resolveSupervisorScope(options: {
  requestContext: RequestContext | undefined;
  projects: Pick<FactoryProjectsStorage, 'get'>;
}): Promise<SupervisorScope | null> {
  const { requestContext } = options;
  if (!requestContext || typeof requestContext.get !== 'function') return null;
  const context = requestContext.get('controller') as AgentControllerRequestContext<MastraCodeState> | undefined;
  const factoryProjectId = supervisorProjectIdFromContext(context);
  if (!factoryProjectId) return null;
  const orgId = getFactoryAuthOrgId(getFactoryAuthUserFromContext(requestContext));
  if (!orgId) return null;
  const project = await options.projects.get({ orgId, id: factoryProjectId });
  if (!project) return null;
  return { orgId, factoryProjectId };
}

/**
 * Session-start hook: stamp the owning project onto a supervisor session and
 * apply the factory's default model. Runs on every (re)creation so a restarted
 * server heals the in-memory state. Sessions
 * that are not supervisors are left untouched.
 */
export async function hydrateSupervisorSession(
  session: FactorySession,
  deps: {
    projects: FactoryProjectsStorage;
  },
): Promise<void> {
  const factoryProjectId =
    parseSupervisorResourceId(session.identity.getId?.()) ??
    parseSupervisorResourceId(session.identity.getResourceId());
  if (!factoryProjectId) return;
  const project = await deps.projects.getById({ id: factoryProjectId });
  if (!project) return;
  const sessionModel = await resolveFactorySessionModel({
    projects: deps.projects,
    factoryProjectId,
    orgId: project.orgId,
  });
  await session.state.set({
    factoryProjectId,
    factoryOrgId: project.orgId,
    factoryModelScope: 'factory',
    factoryOwnerUserId: project.createdBy,
  });
  await primeTenantCredentialsForTenant({
    orgId: project.orgId,
    userId: project.createdBy,
    credentialScope: 'factory',
  });
  await hydrateFactorySession(session, {
    orgId: project.orgId,
    ownerUserId: project.createdBy,
    defaultModelId: sessionModel.modelId,
  });
}
