import { createFactoryRouteAuth, mountFactoryAuth } from '@factory/auth';
import { factoryAuthorizationServer, factoryMcpResource } from '@factory/auth-better-auth';
import { connectTestMcpClient, createTestGoogleAuth, TEST_ORIGIN } from '@factory/auth-better-auth/testing';
import type { GoogleProfile, TestGoogleAuth } from '@factory/auth-better-auth/testing';
import { AuditDomain, CommentsDomain } from '@factory/feed';
import { createFactoryTools } from '@factory/harness-mastra';
import type { FactoryToolDependencies } from '@factory/harness-mastra';
import { FactoryTransitionService } from '@factory/runtime';
import { createSourceControlSessionLookup } from '@factory/session';
import { createFactoryStorageForTests } from '@factory/store/testing';
import { createBoardRegistry } from '@factory/testing';
import { EventEmitterPubSub } from '@mastra/core/events';
import type { Tool } from '@mastra/core/tools';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildFactoryMcpRoutes } from './routes.ts';

/**
 * An MCP client (Claude Code) on Factory's own OAuth server: the real better-auth OAuth provider
 * (Google's token check replaced), the Factory gate, and the real MCP endpoint over Factory
 * storage. The client registers, the person signs in and allows it, and the access token reaches
 * only the person's own organization.
 */

const ADA: GoogleProfile = { sub: 'google-ada', email: 'ada@example.com', name: 'Ada' };
const BOB: GoogleProfile = { sub: 'google-bob', email: 'bob@example.com', name: 'Bob' };

let google: TestGoogleAuth;
let app: Hono;
let adaCookie: string;
let adaProject: string;
let bobOrg: string;
let bobProject: string;

const initialize = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'oauth-test', version: '1.0.0' } },
};

function mcp(project: string, headers: Record<string, string> = {}): Promise<Response> {
  return app.request(`${TEST_ORIGIN}/web/factory/projects/${project}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(initialize),
  });
}

async function organizationOf(cookie: string): Promise<string> {
  const me = await app.request(`${TEST_ORIGIN}/auth/me`, { headers: { cookie } });
  const { user } = (await me.json()) as { user: { organizationId: string } };
  return user.organizationId;
}

beforeEach(async () => {
  google = await createTestGoogleAuth();
  const seed = await createFactoryStorageForTests();
  const routeAuth = createFactoryRouteAuth(google.provider);
  const boards = createBoardRegistry();
  const sourceControl = seed.sourceControl.forIntegration('github');
  const auditDomain = new AuditDomain({ auth: routeAuth, audit: seed.audit, projects: seed.projects });
  const tools: FactoryToolDependencies = {
    workItems: seed.workItems,
    comments: seed.comments,
    feed: new CommentsDomain({
      auth: routeAuth,
      comments: seed.comments,
      workItems: seed.workItems,
      projects: seed.projects,
      audit: auditDomain,
      pubsub: new EventEmitterPubSub(),
    }),
    audit: seed.audit,
    boards,
    transitionService: new FactoryTransitionService({ configVersion: 'oauth-test', boards, storage: seed.workItems, audit: auditDomain }),
    auditRecorder: auditDomain,
    sessions: createSourceControlSessionLookup([sourceControl]),
    sessionModel: { projects: seed.projects, modelDefaults: seed.modelDefaults },
    intake: seed.intake,
    startCoordinator: () => undefined,
    messaging: async () => null,
  };

  app = new Hono();
  mountFactoryAuth(app, { provider: google.provider, publicUrl: TEST_ORIGIN });
  for (const route of buildFactoryMcpRoutes({
    auth: routeAuth,
    publicOrigin: TEST_ORIGIN,
    authorizationServers: [factoryAuthorizationServer(TEST_ORIGIN)],
    resource: factoryMcpResource(TEST_ORIGIN),
    projects: seed.projects,
    sourceControls: [sourceControl],
    tools: { ...tools, create: scope => createFactoryTools({ scope, deps: tools }) as Record<string, Tool<any, any, any, any>> },
  })) {
    app.on([route.method], route.path, c => (route as { handler: (c: Context) => Promise<Response> | Response }).handler(c));
  }

  adaCookie = await google.signIn(ADA);
  const adaOrg = await organizationOf(adaCookie);
  const bobCookie = await google.signIn(BOB);
  bobOrg = await organizationOf(bobCookie);
  adaProject = (await seed.projects.create({ orgId: adaOrg, userId: 'ada', input: { name: 'Ada Factory' } })).id;
  bobProject = (await seed.projects.create({ orgId: bobOrg, userId: 'bob', input: { name: 'Bob Factory' } })).id;
});

describe('MCP clients on Factory OAuth', () => {
  it('publishes the discovery an MCP client follows: a 401 challenge, resource metadata, server metadata', async () => {
    const challenge = await mcp(adaProject);
    expect(challenge.status).toBe(401);
    const resourceMetadataUrl = /resource_metadata="([^"]+)"/.exec(challenge.headers.get('www-authenticate') ?? '')?.[1];
    expect(resourceMetadataUrl).toBe(`${TEST_ORIGIN}/.well-known/oauth-protected-resource/web/factory/projects/${adaProject}/mcp`);

    const resource = (await (await app.request(resourceMetadataUrl!)).json()) as { resource: string; authorization_servers: string[] };
    expect(resource).toMatchObject({
      resource: `${TEST_ORIGIN}/web/factory`,
      authorization_servers: [`${TEST_ORIGIN}/auth/api`],
    });

    const server = await app.request(`${TEST_ORIGIN}/.well-known/oauth-authorization-server/auth/api`);
    expect(server.status).toBe(200);
    expect(await server.json()).toMatchObject({
      issuer: `${TEST_ORIGIN}/auth/api`,
      registration_endpoint: `${TEST_ORIGIN}/auth/api/oauth2/register`,
      code_challenge_methods_supported: ['S256'],
    });
  });

  it('serves the endpoint to a client the person signed in and allowed', async () => {
    const { accessToken } = await connectTestMcpClient(google, adaCookie);

    const response = await mcp(adaProject, { authorization: `Bearer ${accessToken}` });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('"serverInfo"');
  });

  it("does not reach another organization's Factory, by path or by naming it", async () => {
    const { accessToken } = await connectTestMcpClient(google, adaCookie);
    const authorization = `Bearer ${accessToken}`;

    expect((await mcp(bobProject, { authorization })).status).toBe(404);
    const named = await mcp(bobProject, { authorization, 'X-Mastra-Organization-Id': bobOrg });
    expect(named.status).toBe(403);
  });

  it('refuses a token once the person signed out, and a token that is not one', async () => {
    const { accessToken } = await connectTestMcpClient(google, adaCookie);
    const signedOut = await google.api('/sign-out', adaCookie, { method: 'POST', body: {} });
    expect(signedOut.status).toBe(200);

    expect((await mcp(adaProject, { authorization: `Bearer ${accessToken}` })).status).toBe(401);
    const [header, payload] = accessToken.split('.');
    expect((await mcp(adaProject, { authorization: `Bearer ${header}.${payload}.forged` })).status).toBe(401);
  });

  it('lists the person’s own Factories with their MCP endpoints (the discovery document)', async () => {
    const { accessToken } = await connectTestMcpClient(google, adaCookie);
    const listed = await app.request(`${TEST_ORIGIN}/web/factory/mcp`, { headers: { authorization: `Bearer ${accessToken}` } });

    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({
      organizationId: expect.any(String),
      factories: [
        { id: adaProject, name: 'Ada Factory', mcpUrl: `${TEST_ORIGIN}/web/factory/projects/${adaProject}/mcp` },
      ],
    });
    // Another organization's Factories are not hers to list.
    const named = await app.request(`${TEST_ORIGIN}/web/factory/mcp`, {
      headers: { authorization: `Bearer ${accessToken}`, 'X-Mastra-Organization-Id': bobOrg },
    });
    expect(named.status).toBe(403);
  });

  it('answers the discovery document only to a signed-in person', async () => {
    expect((await app.request(`${TEST_ORIGIN}/web/factory/mcp`)).status).toBe(401);
  });

  it('refuses a token that expired', async () => {
    const { accessToken } = await connectTestMcpClient(google, adaCookie);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000);
      expect((await mcp(adaProject, { authorization: `Bearer ${accessToken}` })).status).toBe(401);
    } finally {
      vi.useRealTimers();
    }
  });
});
