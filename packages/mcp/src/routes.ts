import { createHash } from 'node:crypto';

import type { ApiRoute } from '@mastra/core/server';
import { registerApiRoute } from '@mastra/core/server';
import { createTool } from '@mastra/core/tools';
import type { Tool } from '@mastra/core/tools';
import { MCPServer } from '@mastra/mcp';
import { toFetchResponse, toReqRes } from 'fetch-to-node';
import type { Context } from 'hono';
import { z } from 'zod';

import { getFactoryAuthUser } from '@factory/auth';
import { PLATFORM_AUTH_PROVIDER } from '@factory/auth';
import type { RouteAuth } from '@factory/http';
import { ensureFactorySourceSession, FactorySourceSessionResolutionError, supervisorResourceId } from '@factory/session';
import type { SourceControlSessionLookup } from '@factory/session';
import { auditActorProfile } from '@factory/store';
import type {
  AuditActorProfileInput,
  AuditStorage,
  FactoryProjectsStorage,
  SourceControlStorageHandle,
  WorkItemsStorage,
} from '@factory/store';
import { FACTORY_TOOL_ANNOTATIONS } from './annotations.ts';
import { propagateClientDisconnect } from './disconnect.ts';
import { factoryActivityEvent } from './events.ts';
import { FACTORY_SESSION_TOKEN_HEADER } from './session-token.ts';
import type { FactorySessionTokenSigner } from './session-token.ts';

export const FACTORY_MCP_PATH = '/web/factory/projects/:projectId/mcp';
const PROTECTED_RESOURCE_PREFIX = '/.well-known/oauth-protected-resource';

/**
 * Tools an MCP client never gets. `factory_message_origin` answers the session
 * that started this one; a connector session is started by a person, not a session.
 */
const EXCLUDED_TOOLS = new Set(['factory_message_origin']);

export interface FactoryMcpConfig {
  /** Serve the MCP endpoint. Default `true`; it is never served without an auth provider. */
  enabled?: boolean;
  /**
   * OAuth authorization servers advertised in the protected-resource metadata
   * (RFC 9728) so clients like ChatGPT know where to sign in. Defaults to the
   * `MASTRA_FACTORY_MCP_AUTHORIZATION_SERVER` env var, then to Mastra Platform's
   * AuthKit when the Factory uses Platform auth. The endpoint isn't served
   * without one, since clients would have nowhere to sign in.
   */
  authorizationServers?: string[];
  /**
   * Serve without an OAuth authorization server. Only for auth providers that
   * identify callers without a token, like the loopback-only local dev auth;
   * any other caller gets a 401 with nowhere to sign in.
   */
  tokenless?: boolean;
}

/**
 * MCP requires a server version. The Factory doesn't expose its package
 * version at runtime, so this versions the endpoint's interface instead.
 */
const FACTORY_MCP_SERVER_VERSION = '1.0.0';

/** What a connected client is told the server is for and where to start. */
const FACTORY_MCP_INSTRUCTIONS = [
  'A Mastra Factory tracks software work as work items on a board; agent sessions plan and build them.',
  'Start with `factory_list_attention` for what needs a person, or `search` and `fetch` to find a work item.',
  'Work item tools file, update, move and follow items; session tools start, message and follow the agent sessions working on them.',
  'Every call runs as the signed-in user. When the Factory has a repository, session tools act from a private connector session of theirs.',
].join(' ');

/** Mastra Platform's WorkOS AuthKit, which issues tokens Platform's `/auth/verify` accepts. */
export const PLATFORM_MCP_AUTHORIZATION_SERVER = 'https://auth-kit.mastra.ai';

export function resolveMcpAuthorizationServers(
  providerName: string | undefined,
  config: FactoryMcpConfig | undefined,
  env: Record<string, string | undefined> = process.env,
): string[] {
  if (config?.authorizationServers?.length) return config.authorizationServers;
  const fromEnv = env.MASTRA_FACTORY_MCP_AUTHORIZATION_SERVER?.trim();
  if (fromEnv) return [fromEnv];
  if (providerName === PLATFORM_AUTH_PROVIDER) return [PLATFORM_MCP_AUTHORIZATION_SERVER];
  return [];
}

export interface FactoryMcpRoutesDeps {
  auth: RouteAuth;
  publicOrigin: string;
  authorizationServers: string[];
  projects: Pick<FactoryProjectsStorage, 'get'>;
  /** Source-control handles a connector session can be filed under, tried in order. */
  sourceControls: readonly SourceControlStorageHandle[];
  tools: FactoryMcpToolDependencies;
  /**
   * Verifies session tokens (see `session-token.ts`), so agent sessions the
   * Factory runs outside Mastra reach the endpoint as their own bound session.
   * Unset → session tokens are refused.
   */
  sessionTokens?: Pick<FactorySessionTokenSigner, 'verify'>;
  /** Serve signed-in people (the connector path). `false` serves session tokens only. Default `true`. */
  allowUsers?: boolean;
}

/**
 * Who an MCP client acts as. A signed-in person gets a `user` scope with the
 * reach of a web UI turn; an agent session holding a session token gets the
 * `worker` scope its bound run would get in Mastra. Matches the agent tools' scope.
 * The Factory's chat (the supervisor session) on Claude Code gets a
 * `supervisor` scope: the supervisor's read and repair tools, nothing else.
 */
export interface FactoryMcpToolScope {
  orgId: string;
  factoryProjectId: string;
  userId: string;
  sessionId: string;
  resourceId: string;
  threadId: string;
  kind: 'user' | 'worker' | 'supervisor';
  /** True only for a signed-in person; a worker's turns were started by rules. */
  interactive: boolean;
  actorProfile?: AuditActorProfileInput;
}

/** A scope the Factory's agent tools are built for: a person's or a bound session's. */
export type FactoryMcpAgentScope = FactoryMcpToolScope & { kind: 'user' | 'worker' };

/**
 * The Factory's agent tools, built by the harness for one scope, and the
 * storage the MCP-only tools and events read. The endpoint only chooses which
 * tools a client sees; the tools themselves are the ones agent sessions get.
 */
export interface FactoryMcpToolDependencies {
  create: (scope: FactoryMcpAgentScope) => Record<string, Tool<any, any, any, any>>;
  /**
   * Tools only a bound worker session has (the governed card move, review
   * verdicts), built for its binding. They take precedence over `create`'s.
   */
  createBound?: (
    scope: FactoryMcpAgentScope,
  ) => Record<string, Tool<any, any, any, any>> | Promise<Record<string, Tool<any, any, any, any>>>;
  /**
   * Tools every agent session reaching the endpoint with its token gets (a
   * Claude Code session), bound or not: the ones a Mastra session has
   * in-process, such as the brokered source-control tools. They never replace
   * a tool the endpoint serves itself.
   */
  createSession?: (
    scope: FactoryMcpAgentScope,
  ) => Record<string, Tool<any, any, any, any>> | Promise<Record<string, Tool<any, any, any, any>>>;
  /**
   * The supervisor's tools (health check, records, repairs) for the Factory's
   * chat on Claude Code, acting as `scope.userId`. Unset → supervisor tokens are refused.
   */
  createSupervisor?: (
    scope: FactoryMcpToolScope,
  ) => Record<string, Tool<any, any, any, any>> | Promise<Record<string, Tool<any, any, any, any>>>;
  workItems: Pick<WorkItemsStorage, 'list' | 'getForProject' | 'hasRunBindingForSession'>;
  sessions: Pick<SourceControlSessionLookup, 'getBySessionId'>;
  audit: Pick<AuditStorage, 'list'>;
}

/** The connector session a user's MCP client acts from: one per user and Factory, stable across requests. */
export function connectorSessionId(orgId: string, userId: string, factoryProjectId: string): string {
  const hex = createHash('sha256').update(`mcp\0${orgId}\0${userId}\0${factoryProjectId}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Get or create the private user session behind a person's MCP client, so
 * session-scoped tools (start/signal sessions, follow work items) have a real
 * session to act from. A Factory without a connected repository has nowhere to
 * file one; its tools still run against the stable id.
 */
async function ensureConnectorSession(
  deps: FactoryMcpRoutesDeps,
  args: { orgId: string; userId: string; factoryProjectId: string },
): Promise<{ sessionId: string; persisted: boolean }> {
  const sessionId = connectorSessionId(args.orgId, args.userId, args.factoryProjectId);
  if (await deps.tools.sessions.getBySessionId(sessionId)) return { sessionId, persisted: true };
  for (const sourceControl of deps.sourceControls) {
    try {
      await ensureFactorySourceSession({
        sourceControl,
        orgId: args.orgId,
        factoryProjectId: args.factoryProjectId,
        branch: `factory/mcp-${sessionId.slice(0, 8)}`,
        attributeToUserId: args.userId,
        sessionId,
        visibility: 'private',
      });
      return { sessionId, persisted: true };
    } catch (error) {
      if (!(error instanceof FactorySourceSessionResolutionError)) throw error;
    }
  }
  return { sessionId, persisted: false };
}

function workItemUrl(publicOrigin: string, factoryProjectId: string, workItemId: string): string {
  return `${publicOrigin}/factory/${encodeURIComponent(factoryProjectId)}/work-items/${encodeURIComponent(workItemId)}`;
}

/**
 * `search` and `fetch`, the two tools ChatGPT's connectors and deep research
 * look for, answered from the Factory's work items.
 */
function createSearchFetchTools(
  scope: FactoryMcpToolScope,
  deps: FactoryMcpRoutesDeps,
  inspect: Tool<any, any, any, any> | undefined,
): Record<string, Tool<any, any, any, any>> {
  const project = { orgId: scope.orgId, factoryProjectId: scope.factoryProjectId };
  return {
    search: createTool({
      id: 'search',
      description:
        'Search this Factory’s work items by title or id. Returns matching items with ids to pass to `fetch`.',
      inputSchema: z.object({ query: z.string().describe('Words to look for in work item titles.') }),
      execute: async ({ query }) => {
        const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
        const items = await deps.tools.workItems.list(project);
        const results = items
          .filter(item => {
            const haystack = `${item.id} ${item.title}`.toLowerCase();
            return terms.every(term => haystack.includes(term));
          })
          .slice(0, 20)
          .map(item => ({
            id: item.id,
            title: item.title,
            url: workItemUrl(deps.publicOrigin, scope.factoryProjectId, item.id),
          }));
        return { results };
      },
    }),
    fetch: createTool({
      id: 'fetch',
      description: 'Fetch everything the Factory knows about one work item, by the id `search` returned.',
      inputSchema: z.object({ id: z.string().describe('Work item id.') }),
      execute: async ({ id }, context) => {
        if (!inspect?.execute) throw new Error('Work item details are unavailable.');
        const details = (await inspect.execute({ workItem: id }, context)) as { item?: { title?: string } };
        return {
          id,
          title: details.item?.title ?? id,
          text: JSON.stringify(details, null, 2),
          url: workItemUrl(deps.publicOrigin, scope.factoryProjectId, id),
          metadata: { factoryProjectId: scope.factoryProjectId },
        };
      },
    }),
  };
}

/** The tools a signed-in person's MCP client sees for one Factory. */
export function createFactoryMcpTools(
  scope: FactoryMcpAgentScope,
  deps: FactoryMcpRoutesDeps,
  options: { persistedSession?: boolean } = {},
): Record<string, Tool<any, any, any, any>> {
  const factoryTools = deps.tools.create(scope);
  const tools: Record<string, Tool<any, any, any, any>> = {};
  for (const [name, tool] of Object.entries(factoryTools)) {
    if (EXCLUDED_TOOLS.has(name)) continue;
    // Starting a sub-session needs a real parent session row to file it under.
    if (name === 'factory_start_session' && options.persistedSession === false) continue;
    tools[name] = tool;
  }
  // A worker reads its own card through its bound tools; searching the whole Factory is a person's tool.
  if (scope.kind === 'user') {
    Object.assign(tools, createSearchFetchTools(scope, deps, factoryTools.factory_inspect_work_item));
  }
  for (const [name, tool] of Object.entries(tools)) {
    const annotations = FACTORY_TOOL_ANNOTATIONS[name];
    if (annotations) tool.mcp = { ...tool.mcp, annotations };
  }
  return tools;
}

function resourceMetadataUrl(deps: FactoryMcpRoutesDeps, mcpPath: string): string {
  return `${deps.publicOrigin}${PROTECTED_RESOURCE_PREFIX}${mcpPath}`;
}

function unauthorized(deps: FactoryMcpRoutesDeps, mcpPath: string, error = 'unauthorized'): Response {
  return new Response(JSON.stringify({ error }), {
    status: 401,
    headers: {
      'Content-Type': 'application/json',
      'WWW-Authenticate': `Bearer resource_metadata="${resourceMetadataUrl(deps, mcpPath)}"`,
    },
  });
}

/**
 * The worker scope a session token grants, or `null`. The token only names
 * coordinates; the session row and its run binding are what make them real,
 * so a token for a session that never ran a card, or one in another Factory,
 * buys nothing.
 */
export async function resolveSessionTokenScope(
  deps: Pick<FactoryMcpRoutesDeps, 'sessionTokens' | 'projects' | 'tools'>,
  token: string | undefined,
  factoryProjectId: string,
): Promise<{ scope: FactoryMcpToolScope; projectName: string } | null> {
  const claims = deps.sessionTokens?.verify(token);
  if (!claims || claims.factoryProjectId !== factoryProjectId) return null;
  if (claims.scope === 'supervisor') {
    // Only the Factory's own supervisor session, in the org that owns the Factory.
    if (claims.sessionId !== supervisorResourceId(factoryProjectId) || !claims.userId) return null;
    const project = await deps.projects.get({ orgId: claims.orgId, id: factoryProjectId });
    if (!project) return null;
    return {
      projectName: project.name,
      scope: {
        orgId: claims.orgId,
        factoryProjectId,
        userId: claims.userId,
        sessionId: claims.sessionId,
        resourceId: claims.resourceId,
        threadId: claims.threadId,
        kind: 'supervisor',
        interactive: false,
      },
    };
  }
  const row = await deps.tools.sessions.getBySessionId(claims.sessionId);
  if (!row || row.orgId !== claims.orgId || row.factoryProjectId !== factoryProjectId) return null;
  const project = await deps.projects.get({ orgId: claims.orgId, id: factoryProjectId });
  if (!project) return null;
  // As for a Mastra session: a side session, or one that ever ran a role, is a worker.
  const worker =
    Boolean(row.originSessionId) ||
    (await deps.tools.workItems.hasRunBindingForSession({
      orgId: claims.orgId,
      factoryProjectId,
      sessionId: claims.sessionId,
    }));
  return {
    projectName: project.name,
    scope: {
      orgId: claims.orgId,
      factoryProjectId,
      // A worker acts as its session row, like a dispatcher-driven Mastra run; a
      // person's own session (a Claude Code chat) acts as its owner.
      userId: row.userId,
      sessionId: claims.sessionId,
      resourceId: claims.resourceId,
      threadId: claims.threadId,
      kind: worker ? 'worker' : 'user',
      // The token cannot tell who started the turn, so nothing only a person may do.
      interactive: false,
    },
  };
}

async function serveTools(
  c: Context,
  mcpPath: string,
  options: {
    factoryProjectId: string;
    projectName: string | undefined;
    tools: Record<string, Tool<any, any, any, any>>;
    events?: ConstructorParameters<typeof MCPServer>[0]['events'];
  },
): Promise<Response> {
  const server = new MCPServer({
    id: `factory-${options.factoryProjectId}`,
    name: `${options.projectName ?? 'Mastra'} Factory`,
    version: FACTORY_MCP_SERVER_VERSION,
    description: 'Manage work items, sessions and decisions in a Mastra Factory.',
    instructions: FACTORY_MCP_INSTRUCTIONS,
    // VS Code, Cursor and Claude Code still open with 2025-era `initialize`; serve them statelessly.
    legacy: 'stateless',
    tools: options.tools,
    ...(options.events ? { events: options.events } : {}),
  });

  const { req, res } = toReqRes(c.req.raw);
  const done = server
    .startHTTP({ url: new URL(c.req.url), httpPath: mcpPath, req, res })
    .catch(error => {
      console.warn('[factory] MCP request failed:', error);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null }),
        );
      }
    })
    .finally(() => void server.close());
  const response = propagateClientDisconnect(await toFetchResponse(res), res);
  if (res.writableEnded) await done;
  return response;
}

/** A bound agent session's request: its tools, scoped to its own binding. */
async function handleSessionMcp(
  deps: FactoryMcpRoutesDeps,
  c: Context,
  mcpPath: string,
  factoryProjectId: string,
  token: string,
): Promise<Response> {
  const resolved = await resolveSessionTokenScope(deps, token, factoryProjectId);
  // Never fall through to the person path: a request that brought a session token stands or falls by it.
  if (!resolved) return c.json({ error: 'invalid_session_token' }, 401);
  if (resolved.scope.kind === 'supervisor') {
    if (!deps.tools.createSupervisor) return c.json({ error: 'invalid_session_token' }, 401);
    const tools = { ...(await deps.tools.createSupervisor(resolved.scope)) };
    for (const [name, tool] of Object.entries(tools)) {
      const annotations = FACTORY_TOOL_ANNOTATIONS[name];
      if (annotations) tool.mcp = { ...tool.mcp, annotations };
    }
    return serveTools(c, mcpPath, { factoryProjectId, projectName: resolved.projectName, tools });
  }
  const scope = resolved.scope as FactoryMcpAgentScope;
  const tools = createFactoryMcpTools(scope, deps, { persistedSession: true });
  // The endpoint's own tools stand: they are scoped for MCP. The session's only fill in what it lacks.
  for (const [name, tool] of Object.entries((await deps.tools.createSession?.(scope)) ?? {})) tools[name] ??= tool;
  if (scope.kind === 'worker') Object.assign(tools, (await deps.tools.createBound?.(scope)) ?? {});
  return serveTools(c, mcpPath, { factoryProjectId, projectName: resolved.projectName, tools });
}

async function handleMcp(deps: FactoryMcpRoutesDeps, c: Context): Promise<Response> {
  const factoryProjectId = c.req.param('projectId') ?? '';
  const mcpPath = new URL(c.req.url).pathname;

  const sessionToken = c.req.header(FACTORY_SESSION_TOKEN_HEADER);
  if (sessionToken !== undefined) return handleSessionMcp(deps, c, mcpPath, factoryProjectId, sessionToken);
  if (deps.allowUsers === false) return unauthorized(deps, mcpPath);

  await deps.auth.ensureUser(c);
  const tenant = deps.auth.tenant(c);
  if (!tenant) return unauthorized(deps, mcpPath);
  if (!tenant.orgId) return c.json({ error: 'organization_required' }, 403);

  const project = await deps.projects.get({ orgId: tenant.orgId, id: factoryProjectId });
  if (!project) return c.json({ error: 'not_found' }, 404);

  const { sessionId, persisted } = await ensureConnectorSession(deps, {
    orgId: tenant.orgId,
    userId: tenant.userId,
    factoryProjectId,
  });
  const actorProfile = auditActorProfile(getFactoryAuthUser(c));
  const scope: FactoryMcpAgentScope = {
    orgId: tenant.orgId,
    factoryProjectId,
    userId: tenant.userId,
    sessionId,
    // A user session's memory lives under its owner.
    resourceId: tenant.userId,
    threadId: sessionId,
    kind: 'user',
    // A signed-in person is driving the client: the same reach as a web UI turn.
    interactive: true,
    ...(actorProfile ? { actorProfile } : {}),
  };

  return serveTools(c, mcpPath, {
    factoryProjectId,
    projectName: project.name,
    tools: createFactoryMcpTools(scope, deps, { persistedSession: persisted }),
    events: {
      'factory.activity': factoryActivityEvent({
        orgId: tenant.orgId,
        factoryProjectId,
        audit: deps.tools.audit,
        workItems: deps.tools.workItems,
        sessions: deps.tools.sessions,
        viewer: { orgId: tenant.orgId, userId: tenant.userId },
      }),
    },
  });
}

/**
 * The Factory's MCP endpoint: Streamable HTTP at
 * `/web/factory/projects/:projectId/mcp`, plus its RFC 9728 protected-resource
 * metadata. Callers sign in with OAuth through the Factory's auth provider and
 * get the tools a web UI session would, under the same permissions.
 */
export function buildFactoryMcpRoutes(deps: FactoryMcpRoutesDeps): ApiRoute[] {
  const handler = (c: unknown) => handleMcp(deps, c as Context);
  return [
    ...(['POST', 'GET', 'DELETE'] as const).map(method =>
      registerApiRoute(FACTORY_MCP_PATH, { method, requiresAuth: false, handler }),
    ),
    registerApiRoute(`${PROTECTED_RESOURCE_PREFIX}${FACTORY_MCP_PATH}`, {
      method: 'GET',
      requiresAuth: false,
      handler: c => {
        const mcpPath = new URL(c.req.url).pathname.slice(PROTECTED_RESOURCE_PREFIX.length);
        return c.json({
          resource: `${deps.publicOrigin}${mcpPath}`,
          authorization_servers: deps.authorizationServers,
          bearer_methods_supported: ['header'],
          resource_name: 'Mastra Factory',
        });
      },
    }),
  ];
}
