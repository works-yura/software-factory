import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { fakeRouteAuth, mountApiRoutes } from '@factory/http/testing';
import { buildConnectionRoutes } from '@factory/integrations';
import { describeConnectorContract } from '@factory/integrations/testing';

import { GitLabConnections } from './connections.ts';
import type { GitLabConnectionsSource } from './connections.ts';

function app(source: GitLabConnectionsSource, admin = true) {
  const hono = new Hono();
  hono.use('*', async (c, next) => {
    c.set('factoryAuthUser' as never, { id: 'u-1', organizationId: 'org-1' } as never);
    await next();
  });
  mountApiRoutes(
    hono as never,
    buildConnectionRoutes({ auth: fakeRouteAuth({ isAdmin: async () => admin }), connectors: [{ id: 'gitlab', connections: new GitLabConnections(source) }] }),
  );
  return async (method: string, path: string, body?: unknown) => {
    const res = await hono.request(path, {
      method,
      ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
    });
    return { status: res.status, body: (await res.json()) as any };
  };
}

function platform(connections: Array<{ id: string; status: 'active' | 'needs_reauth'; accountLabel: string | null; displayName?: string | null }>) {
  const minted: string[] = [];
  const source: GitLabConnectionsSource = {
    diagnostics: () => ({ mode: 'platform', endpointHost: 'api.mastra.ai' }),
    statusConnections: async () => connections.map(connection => ({ integrationId: 'gitlab', ...connection })),
    verifyStatus: async () => {},
    platformSessions: () => ({
      connect: async () => (minted.push('connect'), { connectionId: 'new-1', integrationId: 'gitlab', sessionToken: 'tok', expiresAt: 'soon' }),
      reconnect: async (id: string) => (minted.push(`reconnect:${id}`), { connectionId: id, integrationId: 'gitlab', sessionToken: 'tok2', expiresAt: 'soon' }),
    }),
  };
  return { source, minted };
}

describe('GitLab connections (ADR-0035)', () => {
  it('lists Platform accounts with what the organization may do here and what lives on Mastra Platform', async () => {
    const call = app(platform([{ id: 'c-1', status: 'needs_reauth', accountLabel: 'yura', displayName: 'Client' }]).source);
    const [row] = (await call('GET', '/web/connections')).body.connections;
    expect(row).toMatchObject({
      id: 'gitlab:c-1',
      label: 'Client',
      accountLabel: 'yura',
      status: 'needs_reauth',
      state: { tone: 'warning', label: 'Needs sign-in' },
      actions: {
        rename: { reason: 'Managed on Mastra Platform' },
        reconnect: { method: expect.objectContaining({ id: 'platform', authKind: 'oauth' }) },
        remove: { reason: 'Managed on Mastra Platform' },
        manageExternally: { url: 'https://projects.mastra.ai', label: 'Open Mastra Platform' },
      },
    });
  });

  it('connects and reconnects through a Nango session, then reports the account active through getAuthStatus', async () => {
    const connections: Array<{ id: string; status: 'active' | 'needs_reauth'; accountLabel: string | null }> = [];
    const { source, minted } = platform(connections);
    const call = app(source);
    expect((await call('POST', '/web/connections', { connector: 'gitlab', method: 'platform' })).body).toEqual({
      type: 'authorize',
      authId: 'new-1',
      session: { provider: 'nango', token: 'tok', integrationId: 'gitlab', expiresAt: 'soon' },
    });
    expect((await call('GET', '/web/connections/authorizations/new-1?connector=gitlab')).body).toEqual({ status: 'pending' });
    connections.push({ id: 'new-1', status: 'active', accountLabel: 'yura' });
    expect((await call('GET', '/web/connections/authorizations/new-1?connector=gitlab')).body).toEqual({ status: 'completed' });
    expect((await call('POST', '/web/connections/gitlab%3Anew-1/reconnect', { input: {} })).body).toMatchObject({ session: { token: 'tok2' } });
    expect((await call('POST', '/web/connections/gitlab%3Amissing/reconnect', { input: {} })).status).toBe(404);
    expect(minted).toEqual(['connect', 'reconnect:new-1']);
  });

  it('shows the server token in direct mode as one connection changed only in the environment', async () => {
    const call = app({
      diagnostics: () => ({ mode: 'direct', endpointHost: 'gitlab.example.com' }),
      statusConnections: async () => undefined,
      verifyStatus: async () => {},
      platformSessions: () => undefined,
    });
    const [row] = (await call('GET', '/web/connections')).body.connections;
    expect(row).toMatchObject({ id: 'gitlab:direct', label: 'gitlab.example.com', method: 'Server token', state: { tone: 'ok' } });
    expect(row.actions.reconnect).toEqual({ reason: expect.stringContaining('server environment') });
    const [connector] = (await call('GET', '/web/connections/methods')).body.connectors;
    expect(connector.methods).toEqual([expect.objectContaining({ id: 'token', available: { reason: expect.stringContaining('GITLAB_ACCESS_TOKEN') } })]);
    expect((await call('POST', '/web/connections', { connector: 'gitlab', method: 'token' })).status).toBe(409);
  });
});

// The connector conformance kit (`@factory/integrations/testing`): Platform accounts, connected through a Nango session.
describeConnectorContract('GitLab (Mastra Platform)', async () => {
  const connections: Array<{ id: string; status: 'active' | 'needs_reauth'; accountLabel: string | null; displayName?: string | null }> = [
    { id: 'c-1', status: 'active', accountLabel: 'yura', displayName: 'Client' },
  ];
  return {
    registration: { id: 'gitlab', connections: new GitLabConnections(platform(connections).source) },
    orgId: 'org-1',
    admin: 'admin',
    member: 'member',
    expectsConnections: true,
    authorize: { method: 'platform', finish: async authId => void connections.push({ id: authId, status: 'active', accountLabel: 'new' }) },
  };
});

describeConnectorContract('GitLab (server token)', async () => ({
  registration: {
    id: 'gitlab',
    connections: new GitLabConnections({
      diagnostics: () => ({ mode: 'direct', endpointHost: 'gitlab.example.com' }),
      statusConnections: async () => undefined,
      verifyStatus: async () => {},
      platformSessions: () => undefined,
    }),
  },
  orgId: 'org-1',
  admin: 'admin',
  member: 'member',
  expectsConnections: true,
}));
