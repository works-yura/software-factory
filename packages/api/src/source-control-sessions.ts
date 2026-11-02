import type { MountedMastraCode } from '@mastra/code-sdk';
import { resolveModel } from '@mastra/code-sdk/agents/model';
import { RequestContext } from '@mastra/core/request-context';
import type { ApiRoute, IUserProvider } from '@mastra/core/server';
import { registerApiRoute } from '@mastra/core/server';
import { UniqueViolationError } from '@mastra/core/storage';
import type { Context } from 'hono';

import { reclaimDeletedSessionSandbox } from '@factory/sandbox';
import { isValidGitRef } from '@factory/sandbox';
import type { SessionRetirementCoordinator } from '@factory/sandbox';
import { waitForPendingFilesystemCapture } from '@factory/session';
import { seedSessionOrg } from '@factory/session';
import {
  sessionMemoryResourceId,
  listFactorySessionThreads,
  sessionThreadsToMove,
  userSessionResourceFor,
} from '@factory/session';
import { normalizeSessionTitle } from '@factory/session';
import type { FilesystemStorage } from '@factory/store';
import type { MemorySettingsStorage } from '@factory/store';
import { factoryMemorySettingsUserId } from '@factory/store';
import type { FactoryProjectsStorage } from '@factory/store';
import type {
  ProjectRepository,
  SourceControlSession,
  SourceControlStorageHandle,
} from '@factory/store';
import type { WorkItemsStorage } from '@factory/store';
import type { RouteAuth } from '@factory/http';
import { canReadSessionResource, canSwitchSessionModel, canViewSourceControlSession } from '@factory/session';

type RouteContext = Context;

function loose(c: unknown): RouteContext {
  return c as RouteContext;
}

import { USER_SESSION_BRANCH_PREFIX } from '@factory/session';

export { USER_SESSION_BRANCH_PREFIX } from '@factory/session';
// Slack thread sessions live on `slack/<thread>` branches (integrations/slack/slack.ts threadBranch).
const SLACK_SESSION_BRANCH_PREFIX = 'slack/';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_SESSION_OWNER_PROFILES = 100;
const MAX_SESSION_OWNER_PROFILE_CACHE_ENTRIES = 500;
const SESSION_OWNER_PROFILE_TTL_MS = 5 * 60_000;

interface SessionOwnerProfile {
  id: string;
  name: string;
  avatarUrl?: string;
}

type SessionOwnerUserProvider = Pick<IUserProvider, 'getUser'> & Partial<Pick<IUserProvider, 'getUsers'>>;

export interface SourceControlSessionRoutesOptions {
  auth: RouteAuth;
  sourceControls: readonly SourceControlStorageHandle[];
  projects: Pick<FactoryProjectsStorage, 'get'>;
  users?: SessionOwnerUserProvider;
  controller?: MountedMastraCode['controller'];
  memorySettings: Pick<MemorySettingsStorage, 'get'>;
  sessionRetirement?: SessionRetirementCoordinator;
  /**
   * Told when a session is deleted without a retirement coordinator (which tells its own
   * `onSessionDeleted`), e.g. so the Claude Code CLI config dir of the session goes with it.
   */
  onSessionDeleted?: (sessionId: string) => Promise<void> | void;
  /** Whether the host sandbox can recreate a session's sandbox (false for local). */
  sandboxRecreateSupported?: boolean;
  /** Turn-end file listings, cleared on recreate so the panel stops showing the old sandbox's files. */
  filesystem?: Pick<FilesystemStorage, 'deleteResourceFiles'>;
  /** How long recreate waits for an aborted run to settle before destroying. */
  abortSettleTimeoutMs?: number;
  workItems?: Pick<WorkItemsStorage, 'clearSessionReferences' | 'hasRunBindingForSession'>;
  /** Moves a thread, with everything keyed by its resource, when a session's visibility changes. */
  moveThread?: (input: { threadId: string; resourceId: string }) => Promise<unknown>;
  /**
   * Personal sessions of a Factory whose harness is `claude-code` run on Claude
   * Code: created in its session store (the chat then reaches them through the
   * Claude session UI) instead of starting a Mastra conversation. Unset when
   * the server has no Claude Code harness.
   */
  claudeCode?: ClaudeCodeUserSessions;
}

/** How the session routes reach the Claude Code harness for personal sessions. */
export interface ClaudeCodeUserSessions {
  /** The Claude Code session behind a session id, or undefined when Claude Code does not run it. */
  get(sessionId: string): Promise<{ resourceId?: string } | undefined>;
  /** Get-or-create the Claude Code session of a user session: its thread is the session id, under `resourceId`. */
  start(input: { session: SourceControlSession; resourceId: string }): Promise<void>;
  /**
   * Why new Claude Code sessions cannot run on this server (e.g. no local
   * sandbox to check the repository out in); undefined when they can.
   */
  unavailableReason?: string;
}

/** What a personal session of a Claude Code Factory needs and this server cannot give, or undefined. */
function claudeCodeRefusal(options: SourceControlSessionRoutesOptions): string | undefined {
  if (!options.claudeCode) {
    return "This Factory runs on Claude Code, but this server has no Claude Code harness. Switch the Factory's harness to Mastra in Settings → Models, or configure Claude Code on the server.";
  }
  return options.claudeCode.unavailableReason;
}

const ABORT_SETTLE_TIMEOUT_MS = 5_000;
const ABORT_SETTLE_POLL_MS = 50;

type SessionManagePermission = 'allowed' | 'forbidden' | 'not-found';

/**
 * Who may manage a session's sandbox: its owner, or an org admin. Private
 * sessions stay owner-only and look missing to everyone else, matching the
 * session GET. The admin check is a provider call, so owners skip it.
 */
async function sessionManagePermission(
  c: RouteContext,
  auth: RouteAuth,
  tenant: { orgId: string; userId: string },
  session: SourceControlSession,
): Promise<SessionManagePermission> {
  if (session.orgId !== tenant.orgId) return 'not-found';
  const isOwner = session.userId === tenant.userId;
  if (session.visibility === 'private' && !isOwner) return 'not-found';
  if (isOwner) return 'allowed';
  return (await auth.isOrganizationAdmin(c, session.orgId)) ? 'allowed' : 'forbidden';
}

function canRecreateSandbox(options: SourceControlSessionRoutesOptions): boolean {
  return Boolean(options.sessionRetirement) && options.sandboxRecreateSupported === true;
}

type SessionCapabilities = { recreateSandbox: boolean; switchModel: boolean };

function withCapabilities<T extends object>(session: T, capabilities: SessionCapabilities) {
  return { ...session, capabilities };
}

/** Abort the session's active run and wait (bounded) for it to stop. Returns whether a run was aborted. */
async function abortActiveRun(
  controller: MountedMastraCode['controller'] | undefined,
  sessionId: string,
  settleTimeoutMs: number,
): Promise<boolean> {
  if (!controller) return false;
  try {
    const live = await controller.getSession(sessionId);
    if (!live?.stream.isActive()) return false;
    live.abort();
    const deadline = Date.now() + settleTimeoutMs;
    while (live.stream.isActive() && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, ABORT_SETTLE_POLL_MS));
    }
    if (live.stream.isActive()) {
      console.warn('[Factory Sessions] Aborted run did not settle before sandbox recreate', { sessionId });
    }
    return true;
  } catch (error) {
    console.warn('[Factory Sessions] Failed to abort the active run before sandbox recreate', { sessionId, error });
    return false;
  }
}

interface ResolvedProjectRepository {
  sourceControl: SourceControlStorageHandle;
  project: ProjectRepository;
  factoryProjectId: string;
  defaultBranch: string;
}

async function resolveOrgTenant(
  c: RouteContext,
  auth: RouteAuth,
): Promise<{ tenant: { orgId: string; userId: string } } | { response: Response }> {
  await auth.ensureUser(c);
  const tenant = auth.tenant(c);
  if (!tenant) return { response: c.json({ error: 'unauthorized', reason: 'auth_required' }, 401) };
  if (!tenant.orgId) {
    return {
      response: c.json(
        {
          error: 'organization_required',
          message: 'Source-control sessions require an organization.',
        },
        403,
      ),
    };
  }
  return { tenant: { orgId: tenant.orgId, userId: tenant.userId } };
}

async function resolveProjectRepository(
  sourceControls: readonly SourceControlStorageHandle[],
  orgId: string,
  projectRepositoryId: string,
): Promise<ResolvedProjectRepository | null> {
  const matches = (
    await Promise.all(
      sourceControls.map(async sourceControl => {
        const project = await sourceControl.projectRepositories.get({ orgId, id: projectRepositoryId });
        if (!project) return null;
        const repository = await sourceControl.repositories.get({ orgId, id: project.repositoryId });
        if (!repository) return null;
        const connection = await sourceControl.connections.get({ orgId, id: project.connectionId });
        if (!connection) return null;
        return {
          sourceControl,
          project,
          factoryProjectId: connection.factoryProjectId,
          defaultBranch: project.branch ?? repository.defaultBranch,
        };
      }),
    )
  ).filter((match): match is ResolvedProjectRepository => match !== null);
  if (matches.length > 1) {
    throw new Error('Factory project repository exists in multiple source-control providers.');
  }
  return matches[0] ?? null;
}

async function resolveSession(
  sourceControls: readonly SourceControlStorageHandle[],
  sessionId: string,
): Promise<{ sourceControl: SourceControlStorageHandle; session: SourceControlSession } | null> {
  const matches = (
    await Promise.all(
      sourceControls.map(async sourceControl => ({
        sourceControl,
        session: await sourceControl.sessions.getBySessionId(sessionId),
      })),
    )
  ).filter(
    (match): match is { sourceControl: SourceControlStorageHandle; session: SourceControlSession } =>
      match.session !== null,
  );
  if (matches.length > 1) throw new Error('Factory session exists in multiple source-control providers.');
  return matches[0] ?? null;
}

/**
 * Start the live conversation for a user session on its own thread (thread id === session id), under the resource
 * its visibility gives it. Agent-controller
 * routes only act on started sessions, so the first prompt the page sends right after creation always lands on the
 * thread the page reads, with the org and Factory address already in state. Get-or-create, so retried or repeated
 * creates are safe.
 */
async function startUserSessionConversation(
  controller: SourceControlSessionRoutesOptions['controller'],
  session: SourceControlSession,
  // Its owner's resource while private, its Factory's when created shared (a run from a board card).
  resourceId: string = userSessionResourceFor(session, session.visibility === 'org' ? 'org' : 'private'),
) {
  if (!controller) return undefined;
  const requestContext = new RequestContext();
  requestContext.set('user', { workosId: session.userId, organizationId: session.orgId });
  const live = await controller.createSession({
    id: session.sessionId,
    resourceId,
    threadId: session.sessionId,
    ownerId: session.userId,
    requestContext,
  });
  await seedSessionOrg(live, session.orgId);
  // Server-side gates (the transition tool, factory-phase processor) resolve the session address from state, so
  // seed it here rather than waiting for the page to connect.
  if (session.factoryProjectId) {
    await live.state.set({
      factoryProjectId: session.factoryProjectId,
      ...(session.projectRepositoryId ? { projectRepositoryId: session.projectRepositoryId } : {}),
    });
  }
  return live;
}

/**
 * Start a personal session on its Factory's harness: a session Claude Code
 * already holds stays there, a new one follows the Factory (`claude-code` →
 * the Claude Code store, anything else → the Mastra conversation).
 */
async function startPersonalSession(
  options: SourceControlSessionRoutesOptions,
  session: SourceControlSession,
  factoryHarness?: string,
): Promise<{ claude: boolean } | { refused: string }> {
  const held = await options.claudeCode?.get(session.sessionId);
  let harness = factoryHarness;
  if (!held && harness === undefined && session.factoryProjectId) {
    harness = (await options.projects.get({ orgId: session.orgId, id: session.factoryProjectId }))?.harness;
  }
  if (held || harness === 'claude-code') {
    const refused = held ? undefined : claudeCodeRefusal(options);
    if (refused || !options.claudeCode) return { refused: refused ?? 'Claude Code is unavailable.' };
    await options.claudeCode.start({
      session,
      resourceId: held?.resourceId ?? userSessionResourceFor(session, session.visibility === 'org' ? 'org' : 'private'),
    });
    return { claude: true };
  }
  await startUserSessionConversation(options.controller, session);
  return { claude: false };
}

/** A created session as the page reads it; a Claude Code session has no Mastra model to switch. */
function createdSessionPayload(
  options: SourceControlSessionRoutesOptions,
  session: SourceControlSession,
  claude: boolean,
) {
  return {
    ...withCapabilities(session, { recreateSandbox: !claude && canRecreateSandbox(options), switchModel: !claude }),
    ...(claude ? { harness: 'claude-code' as const } : {}),
  };
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function createSessionNaming() {
  const inFlight = new Map<string, Promise<string | null>>();
  return (sessionId: string, run: () => Promise<string | null>) => {
    const pending = inFlight.get(sessionId);
    if (pending) return pending;
    const started = run().finally(() => inFlight.delete(sessionId));
    inFlight.set(sessionId, started);
    return started;
  };
}

function titleModel(modelId: string) {
  return ({ requestContext }: { requestContext: RequestContext }) =>
    resolveModel(modelId, { remapForCodexOAuth: true, requestContext });
}

function createSessionOwnerProfileResolver(users: SessionOwnerUserProvider | undefined) {
  const cache = new Map<string, { profile?: SessionOwnerProfile; expiresAt: number }>();
  const cacheProfile = (userId: string, profile: SessionOwnerProfile | undefined, expiresAt: number) => {
    cache.delete(userId);
    cache.set(userId, { profile, expiresAt });
    if (cache.size > MAX_SESSION_OWNER_PROFILE_CACHE_ENTRIES) {
      const oldestUserId = cache.keys().next().value;
      if (oldestUserId !== undefined) cache.delete(oldestUserId);
    }
  };

  return async (userIds: string[]): Promise<Map<string, SessionOwnerProfile>> => {
    if (!users) return new Map();
    const requestedUserIds = [...new Set(userIds)].slice(0, MAX_SESSION_OWNER_PROFILES);
    const profiles = new Map<string, SessionOwnerProfile>();
    const unresolvedUserIds: string[] = [];
    const now = Date.now();

    for (const userId of requestedUserIds) {
      const cached = cache.get(userId);
      if (!cached || cached.expiresAt <= now) {
        cache.delete(userId);
        unresolvedUserIds.push(userId);
      } else if (cached.profile) {
        profiles.set(userId, cached.profile);
      }
    }
    if (unresolvedUserIds.length === 0) return profiles;

    let resolvedUsers: Array<Awaited<ReturnType<SessionOwnerUserProvider['getUser']>>>;
    if (users.getUsers) {
      try {
        resolvedUsers = await users.getUsers(unresolvedUserIds);
      } catch (error) {
        console.warn('[Factory Sessions] Bulk owner profile lookup failed; falling back to individual lookups', {
          error: error instanceof Error ? error.message : String(error),
        });
        resolvedUsers = (await Promise.allSettled(unresolvedUserIds.map(userId => users.getUser(userId))))
          .filter(result => result.status === 'fulfilled')
          .map(result => result.value);
      }
    } else {
      resolvedUsers = (await Promise.allSettled(unresolvedUserIds.map(userId => users.getUser(userId))))
        .filter(result => result.status === 'fulfilled')
        .map(result => result.value);
    }

    for (const user of resolvedUsers) {
      if (!user) continue;
      const name = user.name?.trim() || user.email?.trim();
      if (!name) continue;
      profiles.set(user.id, {
        id: user.id,
        name,
        ...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}),
      });
    }
    const expiresAt = now + SESSION_OWNER_PROFILE_TTL_MS;
    for (const userId of unresolvedUserIds) cacheProfile(userId, profiles.get(userId), expiresAt);
    return profiles;
  };
}

function withOwnerProfile(session: SourceControlSession, owners: Map<string, SessionOwnerProfile>) {
  const owner = owners.get(session.userId);
  return owner ? { ...session, owner } : session;
}

function projectSessionRoutes(
  path: '/web/source-control/projects/:id/sessions' | '/web/github/projects/:id/sessions',
  options: SourceControlSessionRoutesOptions,
  resolveOwnerProfiles: ReturnType<typeof createSessionOwnerProfileResolver>,
): ApiRoute[] {
  return [
    registerApiRoute(path, {
      method: 'GET',
      requiresAuth: false,
      handler: async c => {
        const resolved = await resolveOrgTenant(loose(c), options.auth);
        if ('response' in resolved) return resolved.response;
        const { orgId, userId } = resolved.tenant;
        const projectRepositoryId = c.req.param('id');
        const project = projectRepositoryId
          ? await resolveProjectRepository(options.sourceControls, orgId, projectRepositoryId)
          : null;
        if (!project) return c.json({ error: 'Project repository not found' }, 404);
        const sessions = await project.sourceControl.sessions.list({
          projectRepositoryId: project.project.id,
          viewerUserId: userId,
        });
        const owners = await resolveOwnerProfiles(sessions.map(session => session.userId));
        return c.json({ sessions: sessions.map(session => withOwnerProfile(session, owners)) });
      },
    }),
    registerApiRoute(path, {
      method: 'POST',
      requiresAuth: false,
      handler: async c => {
        const resolved = await resolveOrgTenant(loose(c), options.auth);
        if ('response' in resolved) return resolved.response;
        const { orgId, userId } = resolved.tenant;
        const projectRepositoryId = c.req.param('id');
        const project = projectRepositoryId
          ? await resolveProjectRepository(options.sourceControls, orgId, projectRepositoryId)
          : null;
        if (!project) return c.json({ error: 'Project repository not found' }, 404);
        let body: unknown;
        try {
          body = await c.req.json();
        } catch {
          return c.json({ error: 'Invalid JSON body' }, 400);
        }
        if (!isJsonObject(body)) return c.json({ error: 'Invalid JSON body' }, 400);
        if (body.baseBranch !== undefined && typeof body.baseBranch !== 'string') {
          return c.json({ error: 'Invalid baseBranch' }, 400);
        }
        const baseBranch = body.baseBranch ?? project.defaultBranch;
        if (!isValidGitRef(baseBranch)) return c.json({ error: 'Invalid baseBranch' }, 400);
        if (
          body.sessionId !== undefined &&
          (typeof body.sessionId !== 'string' || !UUID_PATTERN.test(body.sessionId))
        ) {
          return c.json({ error: 'Invalid sessionId' }, 400);
        }
        const requestedSessionId = body.sessionId;
        const sessionId = requestedSessionId ?? globalThis.crypto.randomUUID();
        if (body.title !== undefined && typeof body.title !== 'string') {
          return c.json({ error: 'Invalid title' }, 400);
        }
        const normalizedTitle = body.title === undefined ? null : normalizeSessionTitle(body.title);
        // Sessions start shared on the Factory. Only a session someone opens for themselves (New session) asks for
        // `private`.
        if (body.visibility !== undefined && body.visibility !== 'private' && body.visibility !== 'org') {
          return c.json({ error: "visibility must be 'private' or 'org'" }, 400);
        }
        const visibility = body.visibility ?? 'org';
        let branch: string;
        if (body.branch === undefined) branch = `${USER_SESSION_BRANCH_PREFIX}${sessionId}`;
        else if (isValidGitRef(body.branch)) branch = body.branch;
        else return c.json({ error: 'Invalid branch' }, 400);

        if (requestedSessionId) {
          const existing = await project.sourceControl.sessions.getBySessionId(sessionId);
          if (existing) {
            if (
              existing.projectRepositoryId !== project.project.id ||
              existing.orgId !== orgId ||
              existing.userId !== userId ||
              existing.branch !== branch
            ) {
              return c.json({ error: 'Session ID conflict' }, 409);
            }
            const harness = await startPersonalSession(options, existing);
            if ('refused' in harness) return c.json({ error: 'claude_code_unavailable', message: harness.refused }, 409);
            return c.json({ session: createdSessionPayload(options, existing, harness.claude) });
          }
        }

        // A Claude Code Factory refuses before writing anything, so a session row never outlives a refused start.
        const factory = await options.projects.get({ orgId, id: project.factoryProjectId });
        if (factory?.harness === 'claude-code') {
          const refused = claudeCodeRefusal(options);
          if (refused) return c.json({ error: 'claude_code_unavailable', message: refused }, 409);
        }

        const session = await project.sourceControl.sessions
          .create({
            sessionId,
            projectRepositoryId: project.project.id,
            factoryProjectId: project.factoryProjectId,
            orgId,
            userId,
            branch,
            baseBranch,
            title: normalizedTitle,
            visibility,
          })
          .catch(async error => {
            if (!(error instanceof UniqueViolationError) || !requestedSessionId) throw error;
            const conflict = await project.sourceControl.sessions.getBySessionId(sessionId);
            if (!conflict) throw error;
            return conflict;
          });
        if (
          requestedSessionId &&
          (session.sessionId !== sessionId ||
            session.projectRepositoryId !== project.project.id ||
            session.orgId !== orgId ||
            session.userId !== userId ||
            session.branch !== branch)
        ) {
          return c.json({ error: 'Session ID conflict' }, 409);
        }
        const harness = await startPersonalSession(options, session, factory?.harness);
        if ('refused' in harness) return c.json({ error: 'claude_code_unavailable', message: harness.refused }, 409);
        // The creator owns the session, so no admin check is needed.
        return c.json({ session: createdSessionPayload(options, session, harness.claude) });
      },
    }),
  ];
}

export function buildSourceControlSessionRoutes(options: SourceControlSessionRoutesOptions): ApiRoute[] {
  const nameSession = createSessionNaming();
  const resolveOwnerProfiles = createSessionOwnerProfileResolver(options.users);
  return [
    registerApiRoute('/web/factory/projects/:id/sessions', {
      method: 'GET',
      requiresAuth: false,
      handler: async c => {
        const resolved = await resolveOrgTenant(loose(c), options.auth);
        if ('response' in resolved) return resolved.response;
        const { orgId, userId } = resolved.tenant;
        const factoryProjectId = c.req.param('id');
        const project = factoryProjectId ? await options.projects.get({ orgId, id: factoryProjectId }) : null;
        if (!project) return c.json({ error: 'Factory not found' }, 404);
        // Storage is partitioned per provider; a Factory's sessions can live in any of them.
        const sessions = (
          await Promise.all(
            options.sourceControls.map(sourceControl =>
              sourceControl.sessions.listByProject({ orgId, factoryProjectId: project.id, viewerUserId: userId }),
            ),
          )
        ).flat();
        const owners = await resolveOwnerProfiles(sessions.map(session => session.userId));
        return c.json({ sessions: sessions.map(session => withOwnerProfile(session, owners)) });
      },
    }),
    ...projectSessionRoutes('/web/source-control/projects/:id/sessions', options, resolveOwnerProfiles),
    // Compatibility for existing clients; new code uses the provider-neutral path.
    ...projectSessionRoutes('/web/github/projects/:id/sessions', options, resolveOwnerProfiles),
    registerApiRoute('/web/user-sessions/:sessionId', {
      method: 'GET',
      requiresAuth: false,
      handler: async c => {
        const resolved = await resolveOrgTenant(loose(c), options.auth);
        if ('response' in resolved) return resolved.response;
        const match = await resolveSession(options.sourceControls, c.req.param('sessionId'));
        const session = match?.session;
        if (!session || !canViewSourceControlSession(session, resolved.tenant)) {
          return c.json({ error: 'Session not found' }, 404);
        }
        // The client opens the session by its id and creates it under this resource.
        const claude = await options.claudeCode?.get(session.sessionId);
        const resourceId =
          claude?.resourceId ?? (await sessionMemoryResourceId(options.controller, session, options.workItems));
        if (!canReadSessionResource(session, resourceId, resolved.tenant)) {
          return c.json({ error: 'Session not found' }, 404);
        }
        const owners = await resolveOwnerProfiles([session.userId]);
        const recreateSandbox =
          !claude &&
          canRecreateSandbox(options) &&
          (await sessionManagePermission(loose(c), options.auth, resolved.tenant, session)) === 'allowed';
        return c.json({
          session: {
            ...withCapabilities(withOwnerProfile(session, owners), {
              recreateSandbox,
              // A Claude Code session runs on its Factory's Claude model, set in settings, not per session.
              switchModel: !claude && canSwitchSessionModel(session, resolved.tenant),
            }),
            resourceId,
            ...(claude ? { harness: 'claude-code' as const } : {}),
          },
        });
      },
    }),
    // Start a session's sandbox without sending it a message, for the Files tab.
    // Brings the controller session online as the row's owner, as a delivered
    // message would, then starts its sandbox; a running sandbox returns at once.
    registerApiRoute('/web/user-sessions/:sessionId/sandbox/start', {
      method: 'POST',
      requiresAuth: false,
      handler: async c => {
        const resolved = await resolveOrgTenant(loose(c), options.auth);
        if ('response' in resolved) return resolved.response;
        const match = await resolveSession(options.sourceControls, c.req.param('sessionId'));
        const session = match?.session;
        if (!session) return c.json({ error: 'Session not found' }, 404);
        const permission = await sessionManagePermission(loose(c), options.auth, resolved.tenant, session);
        if (permission === 'not-found') return c.json({ error: 'Session not found' }, 404);
        if (permission === 'forbidden') {
          return c.json({ error: "Only the session's owner or an organization admin can start its sandbox." }, 403);
        }
        if (await options.claudeCode?.get(session.sessionId)) {
          return c.json(
            { error: 'A Claude Code session checks its repository out when it runs its first turn; send it a message.' },
            409,
          );
        }
        const controller = options.controller;
        if (!controller) return c.json({ error: 'Sessions are not available on this server.' }, 503);

        try {
          const live =
            (await controller.getSession(session.sessionId)) ??
            (await startUserSessionConversation(
              controller,
              session,
              await sessionMemoryResourceId(controller, session, options.workItems),
            ));
          const sandbox = live?.getWorkspace()?.sandbox;
          if (!sandbox?.start) return c.json({ error: 'This session has no sandbox to start.' }, 409);
          await sandbox.start();
          return c.json({ started: true });
        } catch (error) {
          console.error('[Factory Sessions] Failed to start session sandbox', { sessionId: session.sessionId, error });
          return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
        }
      },
    }),
    registerApiRoute('/web/user-sessions/:sessionId/sandbox/recreate', {
      method: 'POST',
      requiresAuth: false,
      handler: async c => {
        const resolved = await resolveOrgTenant(loose(c), options.auth);
        if ('response' in resolved) return resolved.response;
        const match = await resolveSession(options.sourceControls, c.req.param('sessionId'));
        const session = match?.session;
        if (!match || !session) return c.json({ error: 'Session not found' }, 404);
        const permission = await sessionManagePermission(loose(c), options.auth, resolved.tenant, session);
        if (permission === 'not-found') return c.json({ error: 'Session not found' }, 404);
        if (permission === 'forbidden') {
          return c.json({ error: "Only the session's owner or an organization admin can recreate its sandbox." }, 403);
        }
        const sessionRetirement = options.sessionRetirement;
        if (!sessionRetirement || !canRecreateSandbox(options)) {
          return c.json({ error: 'Recreating sandboxes is not available on this server.' }, 503);
        }

        const aborted = await abortActiveRun(
          options.controller,
          session.sessionId,
          options.abortSettleTimeoutMs ?? ABORT_SETTLE_TIMEOUT_MS,
        );
        await waitForPendingFilesystemCapture(session.sessionId).catch(error => {
          console.warn('[Factory Sessions] Failed to drain filesystem capture before sandbox recreate', {
            sessionId: session.sessionId,
            error,
          });
        });
        try {
          const outcome = await sessionRetirement.recreateSessionSandbox({
            sourceControl: match.sourceControl,
            orgId: session.orgId,
            sessionId: session.sessionId,
          });
          if (outcome === 'not-found') return c.json({ error: 'Session not found' }, 404);
          // The captured listings describe the destroyed sandbox; the next turn re-captures.
          await options.filesystem?.deleteResourceFiles({ resourceId: session.sessionId }).catch(error => {
            console.warn('[Factory Sessions] Failed to clear file listings after sandbox recreate', {
              sessionId: session.sessionId,
              error,
            });
          });
          return c.json({ recreated: true, aborted });
        } catch (error) {
          console.error('[Factory Sessions] Failed to recreate session sandbox', {
            sessionId: session.sessionId,
            error,
          });
          return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
        }
      },
    }),
    registerApiRoute('/web/user-sessions/:sessionId', {
      method: 'DELETE',
      requiresAuth: false,
      handler: async c => {
        const resolved = await resolveOrgTenant(loose(c), options.auth);
        if ('response' in resolved) return resolved.response;
        const match = await resolveSession(options.sourceControls, c.req.param('sessionId'));
        const session = match?.session;
        if (
          !match ||
          !session ||
          session.orgId !== resolved.tenant.orgId ||
          session.userId !== resolved.tenant.userId
        ) {
          return c.json({ error: 'Session not found' }, 404);
        }
        try {
          // Drain the turn's queued filesystem capture while the thread and sandbox still exist.
          // A failed drain only costs the snapshot; it must not block teardown.
          await waitForPendingFilesystemCapture(session.sessionId).catch(error => {
            console.warn('[Factory Sessions] Failed to drain filesystem capture before delete', {
              sessionId: session.sessionId,
              error,
            });
          });
          await options.controller?.deleteSession({ sessionId: session.sessionId });
        } catch (error) {
          console.error('[Factory Sessions] Failed to tear down live controller session', {
            sessionId: session.sessionId,
            error,
          });
        }
        if (options.sessionRetirement) {
          await options.sessionRetirement.retireSession({
            sourceControl: match.sourceControl,
            ...(options.workItems ? { workItems: options.workItems } : {}),
            orgId: session.orgId,
            sessionId: session.sessionId,
            deleteSession: true,
          });
        } else {
          await options.workItems?.clearSessionReferences({ orgId: session.orgId, sessionId: session.sessionId });
          await match.sourceControl.sessions.delete(session.id);
          await Promise.resolve(options.onSessionDeleted?.(session.sessionId)).catch((error: unknown) => {
            console.warn('[Factory Sessions] Failed to clean up after deleted session', {
              sessionId: session.sessionId,
              error,
            });
          });
          void reclaimDeletedSessionSandbox({ session }).catch((error: unknown) => {
            console.error('[Factory Sessions] Failed to reclaim sandbox for deleted session', {
              sessionId: session.sessionId,
              sandboxId: session.sandboxId,
              error,
            });
          });
        }
        return c.json({ removed: true });
      },
    }),
    registerApiRoute('/web/user-sessions/:sessionId/visibility', {
      method: 'PUT',
      requiresAuth: false,
      handler: async c => {
        const resolved = await resolveOrgTenant(loose(c), options.auth);
        if ('response' in resolved) return resolved.response;
        const body = (await c.req.json().catch(() => undefined)) as { visibility?: unknown } | undefined;
        const visibility = body?.visibility;
        if (visibility !== 'private' && visibility !== 'org') {
          return c.json({ error: "visibility must be 'private' or 'org'" }, 400);
        }
        const sessionId = c.req.param('sessionId');
        const match = await resolveSession(options.sourceControls, sessionId);
        const row = match?.session;
        // Only the owner may share or unshare; everyone else gets the same 404
        // as a missing session so org-visible ids are not confirmed either.
        if (!match || !row || row.orgId !== resolved.tenant.orgId || row.userId !== resolved.tenant.userId) {
          return c.json({ error: 'Session not found' }, 404);
        }
        // Without work-item storage there's no telling whether this is a Factory
        // run, so refuse rather than let a run be made private.
        if (!options.workItems) {
          return c.json(
            {
              error:
                "Session visibility can't be changed yet: Factory storage is still starting up. Try again in a moment.",
            },
            503,
          );
        }
        // Only sessions a person started in the UI can change. Factory runs and
        // Slack threads keep the visibility they were created with: runs and
        // channel threads stay with the team, Slack DMs stay private.
        if (
          row.branch.startsWith(SLACK_SESSION_BRANCH_PREFIX) ||
          (row.factoryProjectId !== null &&
            (await options.workItems.hasRunBindingForSession({
              orgId: row.orgId,
              factoryProjectId: row.factoryProjectId,
              sessionId,
            })))
        ) {
          return c.json({ error: 'Only user sessions can change visibility' }, 409);
        }
        // A Claude Code session keeps the resource it was created on in its own store; moving it is not supported yet.
        if (await options.claudeCode?.get(sessionId)) {
          return c.json({ error: "Claude Code sessions can't change visibility yet." }, 409);
        }
        // Sharing puts the session on its Factory's memory; without a Factory there is nowhere to share it to.
        if (visibility === 'org' && !row.factoryProjectId) {
          return c.json({ error: "This session isn't linked to a Factory, so it can't be shared." }, 409);
        }
        const resourceId = userSessionResourceFor(row, visibility);
        const controller = options.controller;
        // The resource says who may read a session, so its threads move with it.
        const threadIds = controller ? await sessionThreadsToMove(controller, row, resourceId) : [];
        if (threadIds.length > 0 && !options.moveThread) {
          return c.json({ error: 'Changing session visibility is not available on this server.' }, 503);
        }
        if (controller?.listActiveThreadRuns().some(run => threadIds.includes(run.threadId))) {
          return c.json({ error: 'Wait for the session to finish its run before changing visibility' }, 409);
        }
        // Write in the order that fails closed: threads leave the Factory before the
        // row says private, and the row says shared before threads reach the Factory.
        // A failed move then leaves the session less visible, never more, and a retry
        // moves what is left.
        const moveThreads = async () => {
          for (const threadId of threadIds) await options.moveThread!({ threadId, resourceId });
        };
        if (visibility === 'private') await moveThreads();
        const updated = await match.sourceControl.sessions.setVisibility({ sessionId, visibility });
        if (!updated) return c.json({ error: 'Session not found' }, 404);
        if (visibility === 'org') await moveThreads();
        // A live session keeps the resource it started on. Drop it so the next
        // request resumes on its moved thread, or point it at the new resource
        // when it has no thread to resume from yet.
        const live = await controller?.getSession(sessionId);
        if (live && threadIds.length > 0) await controller!.deleteSession({ sessionId });
        else if (live) await controller!.setResourceId(live, { resourceId });
        const owners = await resolveOwnerProfiles([updated.userId]);
        return c.json({ session: withOwnerProfile(updated, owners) });
      },
    }),
    registerApiRoute('/web/user-sessions/:sessionId/title', {
      method: 'POST',
      requiresAuth: false,
      handler: async c => {
        const resolved = await resolveOrgTenant(loose(c), options.auth);
        if ('response' in resolved) return resolved.response;
        const sessionId = c.req.param('sessionId');
        const match = await resolveSession(options.sourceControls, sessionId);
        const row = match?.session;
        if (!match || !row || row.orgId !== resolved.tenant.orgId || row.userId !== resolved.tenant.userId) {
          return c.json({ error: 'Session not found' }, 404);
        }
        if (!options.controller) return c.json({ error: 'Sessions are not available on this server.' }, 503);
        const threads = await listFactorySessionThreads(options.controller, row, options.workItems);
        const thread = threads.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0];
        if (!thread) return c.json({ error: 'This session has no conversation to name yet.' }, 409);
        // Memory settings belong to the Factory; a session outside any Factory titles on the defaults.
        const stored = row.factoryProjectId
          ? await options.memorySettings.get({
              orgId: row.orgId,
              userId: factoryMemorySettingsUserId(row.factoryProjectId),
            })
          : null;
        const requestContext = new RequestContext();
        requestContext.set('user', { workosId: row.userId, organizationId: row.orgId });
        try {
          const title = await nameSession(sessionId, async () => {
            const generated = await options.controller!.generateThreadTitle({
              threadId: thread.id,
              sessionId,
              requestContext,
              ...(stored?.observerModelId ? { model: titleModel(stored.observerModelId) } : {}),
            });
            const named = generated ? normalizeSessionTitle(generated) : null;
            if (named) await match.sourceControl.sessions.rename({ sessionId, title: named });
            return named;
          });
          if (!title) return c.json({ error: 'The model returned an empty title. Try again.' }, 502);
          return c.json({ title });
        } catch (error) {
          return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
        }
      },
    }),
  ];
}
