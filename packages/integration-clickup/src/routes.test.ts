import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import { fakeRouteAuth, mountApiRoutes } from '@factory/http/testing';
import type { TestAuthUser } from '@factory/http/testing';

import { ClickUpApiError } from './api.ts';
import { ClickUpClients } from './connection.ts';
import type { ClickUpApi, ClickUpConnectionStorage } from './connection.ts';
import { ClickUpIntake } from './intake.ts';
import { buildClickUpRoutes } from './routes.ts';

/** `integration_connections` rows of the ClickUp integration, by organization. */
function memoryConnections() {
  const rows = new Map<string, { data: unknown; metadata: Record<string, unknown>; userId: string | null }>();
  const storage = {
    connections: {
      get: async (orgId: string) => {
        const row = rows.get(orgId);
        return row ? { id: `c-${orgId}`, orgId, userId: row.userId, data: row.data as never, metadata: row.metadata, createdAt: new Date(0), updatedAt: new Date(0) } : null;
      },
      upsert: async (orgId: string, input: { userId?: string | null; data: unknown; metadata?: Record<string, unknown> }) => {
        rows.set(orgId, { data: input.data, metadata: input.metadata ?? {}, userId: input.userId ?? null });
      },
      update: async () => null,
      delete: async (orgId: string) => rows.delete(orgId),
    },
  } as unknown as ClickUpConnectionStorage;
  return { rows, storage };
}

/** ClickUp as it answers each token: `pk_a` is Ann in Acme, `pk_b` is Bob in Beta; any other token is refused. */
function fakeClickUp() {
  const accounts: Record<string, { user: { id: string; username: string }; workspace: string; lists: string[] }> = {
    pk_a: { user: { id: '1', username: 'ann' }, workspace: 'Acme', lists: ['A-1'] },
    pk_b: { user: { id: '2', username: 'bob' }, workspace: 'Beta', lists: ['B-1'] },
  };
  const calls: string[] = [];
  const create = (token: string): ClickUpApi => {
    const account = () => {
      calls.push(token);
      const found = accounts[token];
      if (!found) throw new ClickUpApiError('ClickUp request failed with 401.', 401);
      return found;
    };
    return {
      authorizedUser: async () => account().user,
      listWorkspaces: async () => [{ id: `w-${token}`, name: account().workspace }],
      listLists: async () => account().lists.map(id => ({ id, name: id, path: '', workspaceId: `w-${token}` })),
      getList: async (listId: string) => ({ id: listId, name: listId, statuses: account().lists.includes(listId) ? [{ name: 'open', type: 'open' }] : [] }),
    } as unknown as ClickUpApi;
  };
  return { create, calls };
}

function setup(options: { isAdmin?: (orgId: string, userId: string) => Promise<boolean>; authEnabled?: boolean } = {}) {
  const { rows, storage } = memoryConnections();
  const clickup = fakeClickUp();
  const clients = new ClickUpClients({ storage: () => storage, create: clickup.create });
  const audits: Array<{ action: string; metadata?: Record<string, unknown> }> = [];
  let user: TestAuthUser | null = { id: 'admin-a', organizationId: 'org-a' };
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (user) c.set('factoryAuthUser' as never, user as never);
    await next();
  });
  mountApiRoutes(
    app,
    buildClickUpRoutes({
      auth: fakeRouteAuth({
        enabled: options.authEnabled ?? true,
        isOrganizationAdmin: options.isAdmin ?? (async (_orgId, userId) => userId.startsWith('admin')),
      }),
      clients,
      storage: () => storage,
      intake: new ClickUpIntake(clients),
      intervalSeconds: 60,
      hooks: { emitAudit: async ({ input }) => void audits.push({ action: input.action, ...(input.metadata ? { metadata: input.metadata } : {}) }) },
    }),
  );
  const as = (next: TestAuthUser | null) => {
    user = next;
  };
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await app.request(path, {
      method,
      ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
    });
    return { status: response.status, body: (await response.json()) as any };
  };
  return { rows, audits, call, as, calls: clickup.calls };
}

describe('ClickUp connection routes', () => {
  it('connects a checked token for the organization, stores it, and never sends it back', async () => {
    const { call, rows, audits } = setup();
    expect((await call('GET', '/web/clickup/status')).body).toEqual({
      configured: false,
      connected: false,
      workspaces: [],
      intervalSeconds: 60,
      canManage: true,
    });
    const connected = await call('PUT', '/web/clickup/connection', { token: ' pk_a ' });
    expect(connected.status).toBe(200);
    expect(connected.body).toEqual({
      configured: true,
      connected: true,
      workspaces: ['Acme'],
      account: { username: 'ann' },
      intervalSeconds: 60,
      canManage: true,
      connectedAt: expect.any(String),
      connectedBy: 'admin-a',
    });
    expect(JSON.stringify(connected.body)).not.toContain('pk_a');
    expect(rows.get('org-a')).toEqual({
      data: { apiToken: 'pk_a' },
      metadata: { username: 'ann', userId: '1', workspaces: ['Acme'], connectedBy: 'admin-a' },
      userId: 'admin-a',
    });
    expect(audits).toEqual([{ action: 'factory.integration.token_connected', metadata: { replaced: false, account: 'ann' } }]);
    expect(JSON.stringify(audits)).not.toContain('pk_a');
  });

  it('refuses a token ClickUp rejects with a message that says what to paste, and keeps the stored one', async () => {
    const { call, rows } = setup();
    await call('PUT', '/web/clickup/connection', { token: 'pk_a' });
    const refused = await call('PUT', '/web/clickup/connection', { token: 'pk_wrong' });
    expect(refused.status).toBe(422);
    expect(refused.body).toEqual({ error: 'invalid_token', message: expect.stringContaining('ClickUp rejected this token (401)') });
    expect(rows.get('org-a')?.data).toEqual({ apiToken: 'pk_a' });
    expect((await call('PUT', '/web/clickup/connection', {})).status).toBe(422);
  });

  it('replaces and disconnects the token; the lists then need a new connection', async () => {
    const { call, rows, audits } = setup();
    await call('PUT', '/web/clickup/connection', { token: 'pk_a' });
    const replaced = await call('PUT', '/web/clickup/connection', { token: 'pk_b' });
    expect(replaced.body).toMatchObject({ connected: true, workspaces: ['Beta'], account: { username: 'bob' } });
    expect((await call('GET', '/web/clickup/lists')).body.lists.map((list: { id: string }) => list.id)).toEqual(['B-1']);
    const removed = await call('DELETE', '/web/clickup/connection');
    expect(removed.body).toMatchObject({ configured: false, connected: false });
    expect(rows.has('org-a')).toBe(false);
    expect(await call('GET', '/web/clickup/lists')).toEqual({
      status: 409,
      body: { error: 'clickup_not_connected', message: 'Connect ClickUp for this organization first.' },
    });
    expect(audits.map(audit => audit.action)).toEqual([
      'factory.integration.token_connected',
      'factory.integration.token_connected',
      'factory.integration.token_removed',
    ]);
  });

  it('lets only an organization admin connect, replace or disconnect; members see the state', async () => {
    const { call, as, rows } = setup();
    await call('PUT', '/web/clickup/connection', { token: 'pk_a' });
    as({ id: 'member-a', organizationId: 'org-a' });
    expect((await call('GET', '/web/clickup/status')).body).toMatchObject({ connected: true, canManage: false });
    expect(await call('PUT', '/web/clickup/connection', { token: 'pk_b' })).toEqual({
      status: 403,
      body: { error: 'forbidden', message: 'Only organization admins can connect or disconnect ClickUp.' },
    });
    expect((await call('DELETE', '/web/clickup/connection')).status).toBe(403);
    expect(rows.get('org-a')?.data).toEqual({ apiToken: 'pk_a' });
    as(null);
    expect((await call('GET', '/web/clickup/status')).status).toBe(401);
  });

  it("keeps organizations apart: another organization neither sees nor uses the token, and connects its own", async () => {
    const { call, as, calls } = setup();
    await call('PUT', '/web/clickup/connection', { token: 'pk_a' });
    as({ id: 'admin-b', organizationId: 'org-b' });
    expect((await call('GET', '/web/clickup/status')).body).toMatchObject({ configured: false, connected: false, workspaces: [] });
    expect((await call('GET', '/web/clickup/lists')).status).toBe(409);
    expect((await call('GET', '/web/clickup/lists/A-1/statuses')).status).toBe(409);
    calls.length = 0;
    await call('PUT', '/web/clickup/connection', { token: 'pk_b' });
    expect((await call('GET', '/web/clickup/lists')).body.lists.map((list: { id: string }) => list.id)).toEqual(['B-1']);
    expect(calls).not.toContain('pk_a');
    as({ id: 'admin-a', organizationId: 'org-a' });
    expect((await call('GET', '/web/clickup/lists')).body.lists.map((list: { id: string }) => list.id)).toEqual(['A-1']);
  });

  it('shows a stored token ClickUp now refuses as configured but not connected', async () => {
    const { call, rows } = setup();
    rows.set('org-a', { data: { apiToken: 'pk_revoked' }, metadata: { username: 'ann', userId: '1', workspaces: ['Acme'] }, userId: null });
    expect((await call('GET', '/web/clickup/status')).body).toEqual({
      configured: true,
      connected: false,
      error: 'ClickUp request failed with 401.',
      workspaces: [],
      account: { username: 'ann' },
      intervalSeconds: 60,
      canManage: true,
      connectedAt: expect.any(String),
    });
  });

  it('names the connection, keeps the name and who connected it when the token is replaced', async () => {
    const { call, rows } = setup();
    await call('PUT', '/web/clickup/connection', { token: 'pk_a' });
    const named = await call('PATCH', '/web/clickup/connection/name', { name: ' Eclipt ClickUp ' });
    expect(named.status).toBe(200);
    expect(named.body).toMatchObject({ name: 'Eclipt ClickUp', connectedBy: 'admin-a' });
    expect(rows.get('org-a')?.data).toEqual({ apiToken: 'pk_a' });
    await call('PUT', '/web/clickup/connection', { token: 'pk_a' });
    expect((await call('GET', '/web/clickup/status')).body).toMatchObject({ name: 'Eclipt ClickUp', connectedBy: 'admin-a' });
    expect((await call('PATCH', '/web/clickup/connection/name', { name: null })).body).not.toHaveProperty('name');
  });

  it('lets anyone manage the token when the server runs without sign-in', async () => {
    const isAdmin = vi.fn(async () => false);
    const { call } = setup({ authEnabled: false, isAdmin });
    expect((await call('PUT', '/web/clickup/connection', { token: 'pk_a' })).status).toBe(200);
    expect(isAdmin).not.toHaveBeenCalled();
  });
});
