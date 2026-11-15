import { can } from '@factory/access';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { EventEmitterPubSub } from '@mastra/core/events';
import { MCPClient } from '@mastra/mcp';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuditDomain, CommentsDomain } from '@factory/feed';
import { createFactoryTools } from '@factory/harness-mastra';
import type { FactoryToolDependencies } from '@factory/harness-mastra';
import type { RouteAuth } from '@factory/http';
import { FactoryTransitionService } from '@factory/runtime';
import { createSourceControlSessionLookup } from '@factory/session';
import { createFactoryStorageForTests } from '@factory/store/testing';
import { createBoardRegistry } from '@factory/testing';
import type { Tool } from '@mastra/core/tools';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import { ACTIVITY_SETTLE_MS } from './events.ts';
import { createFactorySessionTokenSigner, FACTORY_SESSION_TOKEN_HEADER } from './session-token.ts';
import type { FactoryMcpRoutesDeps } from './routes.ts';
import {
  buildFactoryMcpRoutes,
  connectorSessionId,
  resolveMcpAuthorizationServers,
} from './routes.ts';

describe('resolveMcpAuthorizationServers', () => {
  it('prefers config, then env', () => {
    expect(resolveMcpAuthorizationServers({ authorizationServers: ['https://a'] }, {})).toEqual(['https://a']);
    expect(resolveMcpAuthorizationServers(undefined, { MASTRA_FACTORY_MCP_AUTHORIZATION_SERVER: 'https://e' })).toEqual([
      'https://e',
    ]);
  });

  it('treats a blank env var as unset', () => {
    expect(resolveMcpAuthorizationServers(undefined, { MASTRA_FACTORY_MCP_AUTHORIZATION_SERVER: '  ' })).toEqual([]);
  });

  it('returns nothing without config', () => {
    expect(resolveMcpAuthorizationServers(undefined, {})).toEqual([]);
  });
});

const PUBLIC_ORIGIN = 'https://factory.example.com';

/**
 * Bearer token → tenant. Platform's `/auth/verify` is the real boundary and
 * can't run here; everything behind it (projects, work items, sessions,
 * subscriptions, audit) is real Factory storage.
 */
const USERS: Record<string, { orgId?: string; userId: string; role?: string }> = {
  'token-alice': { orgId: 'org-1', userId: 'alice' },
  'token-bob': { orgId: 'org-1', userId: 'bob' },
  'token-mallory': { orgId: 'org-2', userId: 'mallory' },
  'token-no-org': { userId: 'drifter' },
  'token-viewer': { orgId: 'org-1', userId: 'vera' },
};

function tokenAuth(): RouteAuth {
  const tenants = new WeakMap<Context, { orgId?: string; userId: string }>();
  return {
    enabled: () => true,
    ensureUser: async c => {
      const token = c.req.header('Authorization')?.replace(/^Bearer /, '');
      const user = token ? USERS[token] : undefined;
      if (user) tenants.set(c, user);
      return user;
    },
    tenant: c => tenants.get(c),
    // Everyone here is a member, except the viewer.
    can: async (c, permission) => can(tenants.get(c)?.userId === 'vera' ? 'viewer' : 'member', permission),
  };
}

async function setup(
  options: Pick<FactoryMcpRoutesDeps, 'sessionTokens' | 'allowUsers'> & {
    createBound?: FactoryMcpRoutesDeps['tools']['createBound'];
    createSession?: FactoryMcpRoutesDeps['tools']['createSession'];
    createSupervisor?: FactoryMcpRoutesDeps['tools']['createSupervisor'];
  } = {},
) {
  const seed = await createFactoryStorageForTests();
  const auth = tokenAuth();
  const boards = createBoardRegistry();
  const sourceControl = seed.sourceControl.forIntegration('github');
  const auditDomain = new AuditDomain({ auth, audit: seed.audit, projects: seed.projects });
  const tools: FactoryToolDependencies = {
    workItems: seed.workItems,
    comments: seed.comments,
    feed: new CommentsDomain({
      auth,
      comments: seed.comments,
      workItems: seed.workItems,
      projects: seed.projects,
      audit: auditDomain,
      pubsub: new EventEmitterPubSub(),
    }),
    audit: seed.audit,
    boards,
    transitionService: new FactoryTransitionService({
      configVersion: 'mcp-test',
      boards,
      storage: seed.workItems,
      audit: auditDomain,
    }),
    auditRecorder: auditDomain,
    sessions: createSourceControlSessionLookup([sourceControl]),
    sessionModel: { projects: seed.projects, modelDefaults: seed.modelDefaults },
    intake: seed.intake,
    startCoordinator: () => undefined,
    // No live agent controller: nothing is mid-run.
    messaging: async () => null,
  };

  const project = await seed.projects.create({ orgId: 'org-1', userId: 'alice', input: { name: 'Acme' } });
  const { item } = await seed.workItems.upsert({
    orgId: 'org-1',
    userId: 'alice',
    factoryProjectId: project.id,
    input: { title: 'Fix the login page', stages: ['intake'], metadata: {} },
  });
  await seed.workItems.upsert({
    orgId: 'org-1',
    userId: 'alice',
    factoryProjectId: project.id,
    input: { title: 'Speed up the board', stages: ['intake'], metadata: {} },
  });

  const app = new Hono();
  const routes = buildFactoryMcpRoutes({
    auth,
    publicOrigin: PUBLIC_ORIGIN,
    authorizationServers: ['https://auth.example.com'],
    projects: seed.projects,
    // No repository is linked, so the connector session has no row to file.
    sourceControls: [sourceControl],
    tools: {
      ...tools,
      create: scope => createFactoryTools({ scope, deps: tools }) as Record<string, Tool<any, any, any, any>>,
      ...(options.createBound ? { createBound: options.createBound } : {}),
      ...(options.createSession ? { createSession: options.createSession } : {}),
      ...(options.createSupervisor ? { createSupervisor: options.createSupervisor } : {}),
    },
    ...(options.sessionTokens ? { sessionTokens: options.sessionTokens } : {}),
    ...(options.allowUsers !== undefined ? { allowUsers: options.allowUsers } : {}),
  });
  for (const route of routes) {
    app.on([route.method], route.path, c =>
      (route as { handler: (c: Context) => Promise<Response> | Response }).handler(c),
    );
  }
  const base = await serve(app);
  /** Link a repository and file sessions under it, the way starting a session does. */
  const createSessions = async (
    sessions: Array<{ sessionId: string; userId: string; visibility: 'org' | 'private'; title?: string }>,
  ) => {
    const installation = await sourceControl.installations.upsert({
      orgId: 'org-1',
      connectedByUserId: 'alice',
      externalId: '1',
    });
    const repository = await sourceControl.repositories.upsert({
      orgId: 'org-1',
      input: { installationId: installation.id, externalId: '2', slug: 'acme/app', defaultBranch: 'main' },
    });
    const connection = await sourceControl.connections.create({
      orgId: 'org-1',
      factoryProjectId: project.id,
      installationId: installation.id,
      createdByUserId: 'alice',
    });
    const link = await sourceControl.projectRepositories.link({
      orgId: 'org-1',
      connectionId: connection.id,
      repositoryId: repository.id,
      createdByUserId: 'alice',
      sandboxProvider: 'local',
      sandboxWorkdir: '/sandbox/app',
    });
    for (const session of sessions) {
      await sourceControl.sessions.create({
        ...session,
        projectRepositoryId: link.id,
        factoryProjectId: project.id,
        orgId: 'org-1',
        branch: `user/${session.sessionId}`,
        baseBranch: 'main',
      });
    }
  };
  return { ...seed, project, item, base, url: mcpUrl(base, project.id), createSessions };
}

const servers: Server[] = [];
const clients: MCPClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.disconnect()));
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))));
});

/** Serve a Hono app over a real HTTP port so MCP clients talk to it end to end. */
async function serve(app: Hono): Promise<string> {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') headers.set(key, value);
    }
    const response = await app.fetch(
      new Request(`http://${req.headers.host}${req.url}`, {
        method: req.method,
        headers,
        body: chunks.length ? Buffer.concat(chunks) : undefined,
      }),
    );
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) for await (const chunk of response.body) res.write(chunk);
    res.end();
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function client(url: string, token: string): MCPClient {
  const mcp = new MCPClient({
    id: `factory-mcp-test-${Math.random()}`,
    servers: {
      factory: { url: new URL(url), requestInit: { headers: { Authorization: `Bearer ${token}` } } },
    },
  });
  clients.push(mcp);
  return mcp;
}

const mcpUrl = (base: string, project: string) => `${base}/web/factory/projects/${project}/mcp`;

const PROTOCOL_VERSION = '2026-07-28';

/**
 * One MCP `2026-07-28` request as Claude's connector sends it: the per-request
 * `_meta` envelope and the `Mcp-Protocol-Version` / `Mcp-Method` / `Mcp-Name`
 * headers derived from it. Shape copied from `@modelcontextprotocol/client`
 * 2.2.0 (`outboundEnvelope` for 2026-07-28 and `_applyBodyDerivedHeaders`).
 */
async function claudeRequest(
  url: string,
  method: string,
  params: Record<string, unknown> = {},
  token?: string,
): Promise<{ status: number; headers: Headers; body: { result?: any; error?: any } | null }> {
  const name = method === 'tools/call' ? (params.name as string) : undefined;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'Mcp-Protocol-Version': PROTOCOL_VERSION,
      'Mcp-Method': method,
      ...(name ? { 'Mcp-Name': name } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION,
          'io.modelcontextprotocol/clientInfo': { name: 'claude-ai', version: '0.1.0' },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
  });
  return { status: response.status, headers: response.headers, body: await readJsonRpc(response) };
}

/** A JSON-RPC reply, whether the server answered with JSON or a one-shot SSE stream. */
async function readJsonRpc(response: Response): Promise<{ result?: any; error?: any } | null> {
  const text = await response.text();
  if (!text) return null;
  if (!response.headers.get('Content-Type')?.includes('text/event-stream')) return JSON.parse(text);
  const messages = text
    .split('\n')
    .filter(line => line.startsWith('data:'))
    .map(line => JSON.parse(line.slice('data:'.length)));
  return messages.find(message => 'result' in message || 'error' in message) ?? null;
}

function toolText(result: { content: Array<{ type: string; text: string }> }): any {
  return JSON.parse(result.content.find(part => part.type === 'text')!.text);
}

describe('Factory MCP server', () => {
  it('Claude’s connector is sent to sign in', async () => {
    const { base, project, url } = await setup();

    const response = await claudeRequest(url, 'server/discover');

    expect(response.status).toBe(401);
    const challenge = response.headers.get('WWW-Authenticate') ?? '';
    const metadataUrl = /resource_metadata="([^"]+)"/.exec(challenge)?.[1];
    expect(metadataUrl).toBe(
      `${PUBLIC_ORIGIN}/.well-known/oauth-protected-resource/web/factory/projects/${project.id}/mcp`,
    );

    // The connector follows the pointer; this server answers it under its local address.
    const metadata = await fetch(`${base}${new URL(metadataUrl!).pathname}`);
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toEqual({
      resource: `${PUBLIC_ORIGIN}/web/factory/projects/${project.id}/mcp`,
      authorization_servers: ['https://auth.example.com'],
      bearer_methods_supported: ['header'],
      resource_name: 'Factory',
    });
  });

  it('Claude’s connector discovers the Factory and lists its tools', async () => {
    const { url } = await setup();

    const discover = await claudeRequest(url, 'server/discover', {}, 'token-alice');
    expect(discover.status).toBe(200);
    expect(discover.body?.error).toBeUndefined();
    expect(discover.body?.result.supportedVersions).toContain(PROTOCOL_VERSION);
    expect(discover.body?.result.capabilities.tools).toBeDefined();
    expect(discover.body?.result._meta['io.modelcontextprotocol/serverInfo']).toMatchObject({ name: 'Acme Factory' });

    const list = await claudeRequest(url, 'tools/list', {}, 'token-alice');
    expect(list.status).toBe(200);
    const tools = new Map<string, any>(list.body!.result.tools.map((tool: any) => [tool.name, tool]));
    for (const name of ['search', 'fetch', 'factory_list_work_items', 'factory_subscribe_work_item']) {
      expect(tools.has(name), name).toBe(true);
    }
    expect(tools.get('search').annotations).toMatchObject({ readOnlyHint: true, title: 'Search work items' });
    expect(tools.get('factory_list_work_items').annotations).toMatchObject({ readOnlyHint: true });
    expect(tools.has('factory_message_origin')).toBe(false);
    // No connected repository, so the connector session has no row to start sub-sessions under.
    expect(tools.has('factory_start_session')).toBe(false);
  });

  it('Claude sees what the Factory is for', async () => {
    const { url } = await setup();

    const discover = await claudeRequest(url, 'server/discover', {}, 'token-alice');
    const instructions: string = discover.body?.result.instructions;
    expect(instructions).toMatch(/A Factory tracks/);
    expect(instructions).toMatch(/signed-in user/);

    // Every tool the instructions point Claude at must be one it can call.
    const list = await claudeRequest(url, 'tools/list', {}, 'token-alice');
    const listed = new Set(list.body!.result.tools.map((tool: { name: string }) => tool.name));
    const named = [...instructions.matchAll(/`([a-z_]+)`/g)].map(match => match[1]);
    expect(named).toEqual(['factory_list_attention', 'search', 'fetch']);
    for (const name of named) expect(listed.has(name), name).toBe(true);
  });

  it('Claude calls a tool and reads real Factory data', async () => {
    const { url, project, item } = await setup();

    const search = await claudeRequest(
      url,
      'tools/call',
      { name: 'search', arguments: { query: 'login' } },
      'token-alice',
    );
    expect(search.status).toBe(200);
    expect(search.body?.result.isError).not.toBe(true);
    expect(toolText(search.body!.result)).toEqual({
      results: [
        {
          id: item.id,
          title: 'Fix the login page',
          url: `${PUBLIC_ORIGIN}/factory/${project.id}/work-items/${item.id}`,
        },
      ],
    });

    const fetched = await claudeRequest(
      url,
      'tools/call',
      { name: 'fetch', arguments: { id: item.id } },
      'token-alice',
    );
    expect(fetched.body?.result.isError).not.toBe(true);
    const document = toolText(fetched.body!.result);
    expect(document).toMatchObject({
      id: item.id,
      title: 'Fix the login page',
      url: `${PUBLIC_ORIGIN}/factory/${project.id}/work-items/${item.id}`,
      metadata: { factoryProjectId: project.id },
    });
    expect(JSON.parse(document.text).item).toMatchObject({ id: item.id, title: 'Fix the login page' });
  });

  it('a write from Claude lands on the caller’s connector session', async () => {
    const { url, project, item, workItems } = await setup();

    const call = await claudeRequest(
      url,
      'tools/call',
      { name: 'factory_subscribe_work_item', arguments: { workItem: item.id } },
      'token-alice',
    );
    expect(call.body?.result.isError).not.toBe(true);

    const sessionId = connectorSessionId('org-1', 'alice', project.id);
    const subscriptions = await workItems.listSessionSubscriptions({
      orgId: 'org-1',
      factoryProjectId: project.id,
      sessionId,
    });
    expect(subscriptions).toEqual([expect.objectContaining({ workItemId: item.id, sessionId, userId: 'alice' })]);
  });

  it('the Mastra MCP client lists and runs the same tools', async () => {
    const { url, item, project } = await setup();
    const tools = await client(url, 'token-alice').listTools();

    expect(Object.keys(tools)).toEqual(expect.arrayContaining(['factory_search', 'factory_fetch']));
    const result = (await tools.factory_search!.execute!({ query: 'login' }, {} as never)) as {
      content: Array<{ type: string; text: string }>;
    };
    expect(toolText(result).results).toEqual([
      { id: item.id, title: 'Fix the login page', url: `${PUBLIC_ORIGIN}/factory/${project.id}/work-items/${item.id}` },
    ]);
  });

  it('an older MCP client (VS Code, Cursor) signs in, lists and runs the tools', async () => {
    const { url, item, project } = await setup();

    // A 2025-era opening: `initialize`, no `_meta` envelope, no 2026 headers.
    const opening = (token?: string) =>
      fetch(url, {
        method: 'POST',
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'vscode', version: '1.0.0' } },
        }),
      });

    const anonymous = await opening();
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('www-authenticate')).toContain('resource_metadata=');

    const signedIn = await opening('token-alice');
    expect(signedIn.status).toBe(200);
    expect(signedIn.headers.has('mcp-session-id')).toBe(false);
    expect((await readJsonRpc(signedIn))?.result).toMatchObject({
      protocolVersion: '2025-11-25',
      serverInfo: { name: 'Acme Factory' },
    });

    const mcp = new MCPClient({
      id: `factory-mcp-legacy-${Math.random()}`,
      servers: {
        factory: {
          url: new URL(url),
          protocolVersion: 'legacy',
          requestInit: { headers: { Authorization: 'Bearer token-alice' } },
        },
      },
    });
    clients.push(mcp);
    const tools = await mcp.listTools();
    expect(mcp.getServerProtocolVersions().factory).not.toBe(PROTOCOL_VERSION);
    expect(Object.keys(tools)).not.toContain('factory_factory_message_origin');
    const result = (await tools.factory_search!.execute!({ query: 'login' }, {} as never)) as {
      content: Array<{ type: string; text: string }>;
    };
    expect(toolText(result).results).toEqual([
      { id: item.id, title: 'Fix the login page', url: `${PUBLIC_ORIGIN}/factory/${project.id}/work-items/${item.id}` },
    ]);
  });

  it('denies a user from another organization', async () => {
    const { url } = await setup();
    const response = await claudeRequest(url, 'tools/list', {}, 'token-mallory');
    expect(response.status).toBe(404);
  });

  it('refuses a viewer of the organization: the tools change things (ADR-0045)', async () => {
    const { url } = await setup();
    const response = await claudeRequest(url, 'tools/list', {}, 'token-viewer');
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ error: 'forbidden', permission: 'run.start' });
  });

  it('refuses a signed-in user without an organization', async () => {
    const { url } = await setup();
    const response = await claudeRequest(url, 'tools/list', {}, 'token-no-org');
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'organization_required' });
  });
});

describe('Factory activity over MCP events', () => {
  // Polling only moves past events once they have settled, so these tests drive the clock.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const tick = (ms: number) => vi.setSystemTime(Date.now() + ms);
  const settle = () => tick(ACTIVITY_SETTLE_MS + 1);

  const poll = (
    url: string,
    token: string,
    cursor: string | null | undefined,
    args: Record<string, unknown> = {},
    options: { maxAgeMs?: number } = {},
  ) =>
    claudeRequest(
      url,
      'events/poll',
      { name: 'factory.activity', arguments: args, ...(cursor === undefined ? {} : { cursor }), ...options },
      token,
    );

  const activity = (action: string) => ({ action, occurredAt: expect.any(String), actor: expect.any(Object) });

  const renameItem = (url: string, workItem: string, title: string) =>
    claudeRequest(
      url,
      'tools/call',
      { name: 'factory_update_work_item', arguments: { workItem, title } },
      'token-alice',
    );

  it('an MCP client finds the activity event type', async () => {
    const { url } = await setup();

    const list = await claudeRequest(url, 'events/list', {}, 'token-alice');

    expect(list.status).toBe(200);
    expect(list.body?.result.events).toEqual([
      expect.objectContaining({ name: 'factory.activity', delivery: ['poll'] }),
    ]);
  });

  it('an MCP client polling Factory activity sees new work item changes once', async () => {
    const { url, project, item, audit } = await setup();
    // Activity from before the client started polling is not replayed.
    await audit.record({
      orgId: 'org-1',
      actorId: 'alice',
      action: 'factory.work_item.created',
      targets: [{ type: 'work_item', id: item.id, name: item.title }],
      factoryProjectId: project.id,
    });

    const start = await poll(url, 'token-alice', null);
    expect(start.body?.result).toMatchObject({ events: [], cursor: expect.any(String) });

    tick(1000);
    const rename = await renameItem(url, item.id, 'Fix the sign-in page');
    expect(rename.body?.result.isError).not.toBe(true);

    settle();
    const next = await poll(url, 'token-alice', start.body!.result.cursor);
    expect(next.body?.result.events).toEqual([
      expect.objectContaining({
        name: 'factory.activity',
        eventId: expect.any(String),
        data: {
          action: 'factory.work_item.updated',
          occurredAt: expect.any(String),
          actor: { type: 'human', id: 'alice' },
          workItemId: item.id,
          summary: expect.stringMatching(/^updated: /),
        },
      }),
    ]);

    const again = await poll(url, 'token-alice', next.body!.result.cursor);
    expect(again.body?.result.events).toEqual([]);
    expect(again.body?.result.cursor).toBe(next.body!.result.cursor);
  });

  it('a client with a cursor the Factory can’t read starts over from now and is told it may have missed events', async () => {
    const { url, project, item, audit } = await setup();
    // Already on the trail: starting over from the start would replay it.
    await audit.record({
      orgId: 'org-1',
      actorId: 'alice',
      action: 'factory.work_item.created',
      targets: [{ type: 'work_item', id: item.id, name: item.title }],
      factoryProjectId: project.id,
    });

    // Well-formed, but its id isn't an audit row id (Postgres would reject it in the query).
    const restart = await poll(url, 'token-alice', '2026-10-21T00:00:00.000Z_row-7');
    expect(restart.status).toBe(200);
    expect(restart.body?.result).toMatchObject({ events: [], truncated: true, cursor: expect.any(String) });

    tick(1000);
    await renameItem(url, item.id, 'Fix the sign-in page');
    settle();
    const next = await poll(url, 'token-alice', restart.body!.result.cursor);
    expect(next.body?.result.events.map((event: any) => event.data.action)).toEqual(['factory.work_item.updated']);
  });

  it('an event written while a poll runs is still delivered on the next poll', async () => {
    const { url, project, item, audit } = await setup();
    const record = (action: string, occurredAt?: Date) =>
      audit.record({
        orgId: 'org-1',
        actorId: 'alice',
        action,
        targets: [{ type: 'work_item', id: item.id, name: item.title }],
        factoryProjectId: project.id,
        ...(occurredAt ? { occurredAt } : {}),
      });
    const start = await poll(url, 'token-alice', null);
    tick(1000);

    await record('factory.work_item.created');
    const during = await poll(url, 'token-alice', start.body!.result.cursor);
    expect(during.body?.result).toMatchObject({ events: [], cursor: start.body!.result.cursor });
    // Written in the same millisecond as that poll, or stamped just before it and committed after.
    await record('factory.work_item.updated');
    await record('factory.work_item.stage_moved', new Date(Date.now() - 10));

    settle();
    const next = await poll(url, 'token-alice', during.body!.result.cursor);
    expect(next.body?.result.events.map((event: any) => event.data.action).sort()).toEqual([
      'factory.work_item.created',
      'factory.work_item.stage_moved',
      'factory.work_item.updated',
    ]);
  });

  it('a client resuming an old cursor with maxAgeMs skips older events and is told it did', async () => {
    const { url, item } = await setup();
    const start = await poll(url, 'token-alice', null);
    tick(1000);
    await renameItem(url, item.id, 'Fix the sign-in page');

    tick(10 * 60_000);
    const resumed = await poll(url, 'token-alice', start.body!.result.cursor, {}, { maxAgeMs: 60_000 });
    expect(resumed.body?.result).toMatchObject({ events: [], truncated: true });
    expect(resumed.body!.result.cursor).not.toBe(start.body!.result.cursor);

    const after = await poll(url, 'token-alice', resumed.body!.result.cursor);
    expect(after.body?.result.events).toEqual([]);
  });

  it.each([
    { cursor: null, truncated: false },
    { cursor: undefined, truncated: false },
    { cursor: '', truncated: true },
    { cursor: 'not-a-cursor', truncated: true },
  ])('a client polling with cursor $cursor starts from now (truncated: $truncated)', async ({ cursor, truncated }) => {
    const { url, project, item, audit } = await setup();
    await audit.record({
      orgId: 'org-1',
      actorId: 'alice',
      action: 'factory.work_item.created',
      targets: [{ type: 'work_item', id: item.id, name: item.title }],
      factoryProjectId: project.id,
    });
    settle();

    const first = await poll(url, 'token-alice', cursor);
    expect(first.status).toBe(200);
    expect(first.body?.result.events).toEqual([]);
    expect(first.body?.result.truncated === true).toBe(truncated);

    settle();
    const next = await poll(url, 'token-alice', first.body!.result.cursor);
    expect(next.body?.result.events).toEqual([]);
  });

  it('activity from another org’s Factory never shows up', async () => {
    const { url, base, item, projects } = await setup();
    const globex = await projects.create({ orgId: 'org-2', userId: 'mallory', input: { name: 'Globex' } });
    const globexUrl = mcpUrl(base, globex.id);

    const start = await poll(globexUrl, 'token-mallory', null);
    tick(1000);
    await renameItem(url, item.id, 'Fix the sign-in page');
    settle();
    const next = await poll(globexUrl, 'token-mallory', start.body!.result.cursor);
    expect(next.body?.result.events).toEqual([]);

    // Naming the other org's work item doesn't get her its activity either.
    const targeted = await poll(globexUrl, 'token-mallory', null, { workItemId: item.id });
    expect(targeted.body?.result).toBeUndefined();
    expect(targeted.body?.error).toMatchObject({ code: -32024 });
  });

  it('session activity reaches the members who can see the session, and work item activity in a private session reaches everyone without naming it', async () => {
    const { url, project, item, audit, createSessions } = await setup();
    await createSessions([
      { sessionId: 'alice-private', userId: 'alice', visibility: 'private', title: 'Alice’s spike' },
      { sessionId: 'bob-private', userId: 'bob', visibility: 'private', title: 'Bob’s spike' },
      { sessionId: 'shared', userId: 'bob', visibility: 'org', title: 'Pairing on login' },
    ]);
    const aliceStart = await poll(url, 'token-alice', null);
    const bobStart = await poll(url, 'token-bob', null);

    const record = async (event: Omit<Parameters<typeof audit.record>[0], 'orgId' | 'factoryProjectId'>) => {
      tick(1);
      await audit.record({ orgId: 'org-1', factoryProjectId: project.id, ...event });
    };
    const signal = (sessionId: string) =>
      record({
        actorId: 'agent:thread-x',
        actorType: 'agent',
        action: 'factory.agent.signaled',
        targets: [{ type: 'session', id: sessionId }],
      });
    await signal('bob-private');
    await signal('shared');
    await signal('ghost-session');
    // An agent's own git activity names no session; its thread is the session.
    await record({
      actorId: 'agent:alice-private',
      actorType: 'agent',
      action: 'factory.agent.push',
      targets: [{ type: 'worktree', id: '/sandbox/app' }],
    });
    // Work item activity inside Bob's private session: others see it, but not which session.
    await record({
      actorId: 'bob',
      actorType: 'human',
      action: 'factory.run.approved',
      targets: [
        { type: 'session', id: 'bob-private' },
        { type: 'work_item', id: item.id, name: item.title },
      ],
    });
    await record({
      actorId: 'agent:bob-private',
      actorType: 'agent',
      action: 'factory.work_item.stage_moved',
      targets: [{ type: 'work_item', id: item.id, name: item.title }],
    });
    // An agent whose thread isn't a session (or no longer is): the work item shows, the thread doesn't.
    await record({
      actorId: 'agent:gone-thread',
      actorType: 'agent',
      action: 'factory.work_item.comment_created',
      targets: [{ type: 'work_item', id: item.id, name: item.title }],
    });
    tick(1);
    await renameItem(url, item.id, 'Fix the sign-in page');

    settle();
    const seen = async (token: string, cursor: string) =>
      (await poll(url, token, cursor)).body?.result.events.map(
        (event: { data: { action: string; sessionId?: string; workItemId?: string; summary: string } }) => event.data,
      );
    expect(await seen('token-alice', aliceStart.body!.result.cursor)).toEqual([
      { ...activity('factory.agent.signaled'), sessionId: 'shared', summary: 'agent signaled: Pairing on login' },
      { ...activity('factory.agent.push'), sessionId: 'alice-private', summary: 'agent push: Alice’s spike' },
      {
        ...activity('factory.run.approved'),
        workItemId: item.id,
        privateSession: true,
        summary: 'run approved: Fix the login page (in a private session)',
      },
      {
        ...activity('factory.work_item.stage_moved'),
        actor: { type: 'agent', id: 'agent' },
        workItemId: item.id,
        privateSession: true,
        summary: 'stage moved: Fix the login page (in a private session)',
      },
      {
        ...activity('factory.work_item.comment_created'),
        actor: { type: 'agent', id: 'agent' },
        workItemId: item.id,
        summary: 'comment created: Fix the login page',
      },
      { ...activity('factory.work_item.updated'), workItemId: item.id, summary: 'updated: Fix the sign-in page' },
    ]);
    expect(await seen('token-bob', bobStart.body!.result.cursor)).toEqual([
      { ...activity('factory.agent.signaled'), sessionId: 'bob-private', summary: 'agent signaled: Bob’s spike' },
      { ...activity('factory.agent.signaled'), sessionId: 'shared', summary: 'agent signaled: Pairing on login' },
      {
        ...activity('factory.run.approved'),
        sessionId: 'bob-private',
        workItemId: item.id,
        summary: 'run approved: Fix the login page',
      },
      {
        ...activity('factory.work_item.stage_moved'),
        actor: { type: 'agent', id: 'agent:bob-private' },
        sessionId: 'bob-private',
        workItemId: item.id,
        summary: 'stage moved: Fix the login page',
      },
      {
        ...activity('factory.work_item.comment_created'),
        actor: { type: 'agent', id: 'agent' },
        workItemId: item.id,
        summary: 'comment created: Fix the login page',
      },
      { ...activity('factory.work_item.updated'), workItemId: item.id, summary: 'updated: Fix the sign-in page' },
    ]);
  });
});

describe('Factory MCP for a bound agent session (session tokens)', () => {
  const signer = createFactorySessionTokenSigner('test-secret');

  /** A card run bound to `session-claude`, the way the start path binds one. */
  async function boundSession(seed: Awaited<ReturnType<typeof setup>>, { interactive = false } = {}) {
    await seed.createSessions([{ sessionId: 'session-claude', userId: 'alice', visibility: 'org' }]);
    await seed.workItems.prepareRunStart({
      orgId: 'org-1',
      userId: 'alice',
      factoryProjectId: seed.project.id,
      workItem: {
        id: seed.item.id,
        input: { title: seed.item.title, stages: ['intake'] },
      },
      role: 'triage',
      session: {
        sessionId: 'session-claude',
        branch: 'user/session-claude',
        threadId: 'session-claude',
      },
      resourceId: seed.project.id,
      kickoffKey: 'kickoff-1',
      kickoffMessage: null,
    });
    return signer.sign({
      orgId: 'org-1',
      factoryProjectId: seed.project.id,
      sessionId: 'session-claude',
      threadId: 'session-claude',
      resourceId: seed.project.id,
      ...(interactive ? { interactive: true } : {}),
    });
  }

  async function sessionRequest(url: string, method: string, params: Record<string, unknown>, token: string) {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'Mcp-Protocol-Version': PROTOCOL_VERSION,
        'Mcp-Method': method,
        ...(method === 'tools/call' ? { 'Mcp-Name': params.name as string } : {}),
        [FACTORY_SESSION_TOKEN_HEADER]: token,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        params: {
          ...params,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION,
            'io.modelcontextprotocol/clientInfo': {
              name: 'claude-code',
              version: '2.1.0',
            },
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }),
    });
    return { status: response.status, body: await readJsonRpc(response) };
  }

  it('signs, verifies and refuses tampered, expired or foreign tokens', () => {
    let now = 1_000;
    const clocked = createFactorySessionTokenSigner('secret-a', {
      now: () => now,
    });
    const claims = {
      orgId: 'o',
      factoryProjectId: 'p',
      sessionId: 's',
      threadId: 't',
      resourceId: 'r',
    };
    const token = clocked.sign(claims, { ttlMs: 500 });
    expect(clocked.verify(token)).toEqual(claims);

    const [prefix, body, mac] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...claims, sessionId: 'other', exp: now + 500 })).toString('base64url');
    expect(clocked.verify(`${prefix}.${forged}.${mac}`)).toBeNull();
    expect(clocked.verify(`${prefix}.${body}.${mac}x`)).toBeNull();
    expect(createFactorySessionTokenSigner('secret-b').verify(token)).toBeNull();
    expect(clocked.verify('s')).toBeNull();
    expect(clocked.verify(undefined)).toBeNull();

    now = 1_500;
    expect(clocked.verify(token)).toBeNull();
  });

  it("gives the turn a signed-in person started what only a person may do, as an HTTP turn of a Mastra session", async () => {
    const createBound = vi.fn(() => ({}));
    const seed = await setup({ sessionTokens: signer, createBound });
    const token = await boundSession(seed, { interactive: true });
    expect((await sessionRequest(seed.url, 'tools/list', {}, token)).status).toBe(200);
    expect(createBound).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-claude', interactive: true }));
    expect(signer.verify(token)).toMatchObject({ interactive: true });
  });

  it('serves a bound session its worker-scoped tools, plus the bound-only ones', async () => {
    const createBound = vi.fn(() => ({
      factory_transition_work_item: createTool({
        id: 'factory_transition_work_item',
        description: 'Bound move.',
        inputSchema: z.object({ stage: z.string() }),
        execute: async ({ stage }) => ({ moved: stage }),
      }),
    }));
    const seed = await setup({ sessionTokens: signer, createBound });
    const token = await boundSession(seed);

    const list = await sessionRequest(seed.url, 'tools/list', {}, token);
    expect(list.status).toBe(200);
    const names = (list.body?.result.tools as Array<{ name: string }>).map(tool => tool.name);
    // A worker gets what a bound Mastra run gets: messaging plus its bound tools, never the person's.
    expect(names).toEqual(expect.arrayContaining(['factory_transition_work_item']));
    expect(names).not.toEqual(expect.arrayContaining(['factory_create_work_item']));
    expect(names).not.toContain('search');
    expect(createBound).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-claude',
        threadId: 'session-claude',
        userId: 'alice',
        kind: 'worker',
        interactive: false,
      }),
    );

    const call = await sessionRequest(
      seed.url,
      'tools/call',
      {
        name: 'factory_transition_work_item',
        arguments: { stage: 'planning' },
      },
      token,
    );
    expect(toolText(call.body?.result)).toEqual({ moved: 'planning' });
  });

  it('refuses a session id without a valid token, and never falls back to the person path', async () => {
    const seed = await setup({ sessionTokens: signer });
    await boundSession(seed);
    for (const token of [
      'session-claude',
      `${signer.sign({ orgId: 'org-1', factoryProjectId: seed.project.id, sessionId: 'session-claude', threadId: 't', resourceId: 'r' })}x`,
    ]) {
      const response = await sessionRequest(seed.url, 'tools/list', {}, token);
      expect(response.status).toBe(401);
    }
  });

  it("serves a person's own session (no run binding) its owner's tools, without the bound-only ones", async () => {
    const createBound = vi.fn(() => ({}));
    const seed = await setup({ sessionTokens: signer, createBound });
    await seed.createSessions([{ sessionId: 'session-unbound', userId: 'alice', visibility: 'org' }]);
    const unbound = signer.sign({
      orgId: 'org-1',
      factoryProjectId: seed.project.id,
      sessionId: 'session-unbound',
      threadId: 'session-unbound',
      resourceId: seed.project.id,
    });
    const list = await sessionRequest(seed.url, 'tools/list', {}, unbound);
    expect(list.status).toBe(200);
    const names = (list.body?.result.tools as Array<{ name: string }>).map(tool => tool.name);
    // A Claude Code chat gets what a person's Mastra chat gets.
    expect(names).toEqual(expect.arrayContaining(['factory_create_work_item']));
    expect(createBound).not.toHaveBeenCalled();
  });

  it('serves every agent session, bound or not, the session tools a Mastra session has in-process', async () => {
    const createSession = vi.fn(() => ({
      source_control_push_branch: createTool({
        id: 'source_control_push_branch',
        description: 'Push.',
        inputSchema: z.object({}),
        execute: async () => ({ pushed: true }),
      }),
    }));
    const seed = await setup({ sessionTokens: signer, createSession });
    const bound = await boundSession(seed);
    await seed.createSessions([{ sessionId: 'session-unbound', userId: 'alice', visibility: 'org' }]);
    const unbound = signer.sign({
      orgId: 'org-1',
      factoryProjectId: seed.project.id,
      sessionId: 'session-unbound',
      threadId: 'session-unbound',
      resourceId: seed.project.id,
    });
    for (const token of [bound, unbound]) {
      const list = await sessionRequest(seed.url, 'tools/list', {}, token);
      const names = (list.body?.result.tools as Array<{ name: string }>).map(tool => tool.name);
      expect(names).toContain('source_control_push_branch');
      const call = await sessionRequest(seed.url, 'tools/call', { name: 'source_control_push_branch', arguments: {} }, token);
      expect(toolText(call.body?.result)).toEqual({ pushed: true });
    }
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-claude', kind: 'worker' }));
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-unbound', kind: 'user' }));
  });

  it("never lets a session tool replace one the endpoint serves itself", async () => {
    const createSession = vi.fn(() => ({
      factory_create_work_item: createTool({
        id: 'factory_create_work_item',
        description: 'Impostor.',
        inputSchema: z.object({}),
        execute: async () => ({ impostor: true }),
      }),
    }));
    const seed = await setup({ sessionTokens: signer, createSession });
    await seed.createSessions([{ sessionId: 'session-unbound', userId: 'alice', visibility: 'org' }]);
    const token = signer.sign({
      orgId: 'org-1',
      factoryProjectId: seed.project.id,
      sessionId: 'session-unbound',
      threadId: 'session-unbound',
      resourceId: seed.project.id,
    });
    const list = await sessionRequest(seed.url, 'tools/list', {}, token);
    const tool = (list.body?.result.tools as Array<{ name: string; description: string }>).find(
      candidate => candidate.name === 'factory_create_work_item',
    );
    expect(tool?.description).not.toBe('Impostor.');
  });

  it('never serves the session tools to a person reaching the endpoint without a session token', async () => {
    const createSession = vi.fn(() => ({}));
    const seed = await setup({ sessionTokens: signer, createSession });
    const response = await fetch(seed.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(response.status).not.toBe(500);
    expect(createSession).not.toHaveBeenCalled();
  });

  it('refuses a token for another Factory, or another org', async () => {
    const seed = await setup({ sessionTokens: signer });
    const bound = await boundSession(seed);
    const other = await seed.projects.create({
      orgId: 'org-1',
      userId: 'alice',
      input: { name: 'Other' },
    });
    expect((await sessionRequest(mcpUrl(seed.base, other.id), 'tools/list', {}, bound)).status).toBe(401);

    const foreignOrg = signer.sign({
      orgId: 'org-2',
      factoryProjectId: seed.project.id,
      sessionId: 'session-claude',
      threadId: 'session-claude',
      resourceId: seed.project.id,
    });
    expect((await sessionRequest(seed.url, 'tools/list', {}, foreignOrg)).status).toBe(401);
  });

  describe('the Factory chat (supervisor) on Claude Code', () => {
    const supervisorTools = () => ({
      factory_health_check: createTool({
        id: 'factory_health_check',
        description: 'Health.',
        inputSchema: z.object({}),
        execute: async () => ({ findings: [] }),
      }),
      factory_retry_decision: createTool({
        id: 'factory_retry_decision',
        description: 'Retry.',
        inputSchema: z.object({ decisionId: z.string() }),
        execute: async ({ decisionId }) => ({ retried: decisionId }),
      }),
    });
    const supervisorToken = (projectId: string, overrides: Record<string, unknown> = {}) =>
      signer.sign({
        orgId: 'org-1',
        factoryProjectId: projectId,
        sessionId: `factory-supervisor:${projectId}`,
        threadId: `factory-supervisor:${projectId}`,
        resourceId: `factory-supervisor:${projectId}`,
        scope: 'supervisor',
        userId: 'bob',
        ...overrides,
      } as never);

    it('serves the supervisor tools only, acting as the person the token names', async () => {
      const createSupervisor = vi.fn(supervisorTools);
      const createBound = vi.fn(() => ({}));
      const seed = await setup({ sessionTokens: signer, createSupervisor, createBound });
      const token = supervisorToken(seed.project.id);

      const list = await sessionRequest(seed.url, 'tools/list', {}, token);
      expect(list.status).toBe(200);
      const names = (list.body?.result.tools as Array<{ name: string }>).map(tool => tool.name).sort();
      expect(names).toEqual(['factory_health_check', 'factory_retry_decision']);
      expect(createBound).not.toHaveBeenCalled();
      expect(createSupervisor).toHaveBeenCalledWith({
        orgId: 'org-1',
        factoryProjectId: seed.project.id,
        userId: 'bob',
        sessionId: `factory-supervisor:${seed.project.id}`,
        threadId: `factory-supervisor:${seed.project.id}`,
        resourceId: `factory-supervisor:${seed.project.id}`,
        kind: 'supervisor',
        interactive: false,
      });
      const call = await sessionRequest(
        seed.url,
        'tools/call',
        { name: 'factory_retry_decision', arguments: { decisionId: 'd-1' } },
        token,
      );
      expect(toolText(call.body?.result)).toEqual({ retried: 'd-1' });
    });

    it("refuses a supervisor token for another Factory's session, another org, without a person, or with no supervisor tools", async () => {
      const seed = await setup({ sessionTokens: signer, createSupervisor: supervisorTools });
      const other = await seed.projects.create({ orgId: 'org-1', userId: 'alice', input: { name: 'Other' } });
      const refused = [
        // The session must be this Factory's own supervisor.
        supervisorToken(seed.project.id, { sessionId: `factory-supervisor:${other.id}` }),
        supervisorToken(seed.project.id, { sessionId: 'session-claude' }),
        supervisorToken(seed.project.id, { orgId: 'org-2' }),
        supervisorToken(seed.project.id, { userId: undefined }),
        supervisorToken(seed.project.id, { scope: 'admin' }),
      ];
      for (const token of refused) {
        expect((await sessionRequest(seed.url, 'tools/list', {}, token)).status).toBe(401);
      }
      // A token for one Factory does not open another's endpoint.
      expect((await sessionRequest(mcpUrl(seed.base, other.id), 'tools/list', {}, supervisorToken(seed.project.id))).status).toBe(401);

      const without = await setup({ sessionTokens: signer });
      expect((await sessionRequest(without.url, 'tools/list', {}, supervisorToken(without.project.id))).status).toBe(401);
    });
  });

  it('refuses session tokens when the endpoint has no verifier', async () => {
    const seed = await setup();
    const token = await boundSession(seed);
    expect((await sessionRequest(seed.url, 'tools/list', {}, token)).status).toBe(401);
  });

  it('serves session tokens only, when people are not let in', async () => {
    const seed = await setup({ sessionTokens: signer, allowUsers: false });
    const token = await boundSession(seed);
    expect((await sessionRequest(seed.url, 'tools/list', {}, token)).status).toBe(200);
    expect((await claudeRequest(seed.url, 'tools/list', {}, 'token-alice')).status).toBe(401);
  });
});
