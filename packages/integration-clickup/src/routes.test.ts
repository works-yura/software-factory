import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import { fakeRouteAuth, mountApiRoutes } from '@factory/http/testing';
import type { TestAuthUser } from '@factory/http/testing';

import { ClickUpApiError } from './api.ts';
import { ClickUpClients } from './connection.ts';
import type { ClickUpApi, ClickUpConnectionStorage } from './connection.ts';
import { ClickUpIntake } from './intake.ts';
import { buildClickUpRoutes } from './routes.ts';
import { buildConnectionRoutes } from '@factory/integrations';
import { ClickUpConnections } from './connections.ts';

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

function setup(
  options: { isAdmin?: (orgId: string, userId: string) => Promise<boolean>; authEnabled?: boolean; routedLists?: Record<string, number> } = {},
) {
  const { rows, storage } = memoryConnections();
  let intakeConfig: Record<string, { enabled: boolean; sourceIds: string[] | null }> = { clickup: { enabled: false, sourceIds: null } };
  const projects = [
    { id: 'fp-1', orgId: 'org-a', name: 'post-airborne' },
    { id: 'fp-2', orgId: 'org-a', name: 'syncts' },
    { id: 'fp-3', orgId: 'org-b', name: 'other' },
  ];
  const clickup = fakeClickUp();
  const clients = new ClickUpClients({ storage: () => storage, create: clickup.create });
  const audits: Array<{ action: string; metadata?: Record<string, unknown> }> = [];
  let user: TestAuthUser | null = { id: 'admin-a', organizationId: 'org-a' };
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (user) c.set('factoryAuthUser' as never, user as never);
    await next();
  });
  const auth = fakeRouteAuth({
    enabled: options.authEnabled ?? true,
    isOrganizationAdmin: options.isAdmin ?? (async (_orgId, userId) => userId.startsWith('admin')),
  });
  const emitAudit = async ({ input }: { input: { action: string; metadata?: Record<string, unknown> } }) =>
    void audits.push({ action: input.action, ...(input.metadata ? { metadata: input.metadata } : {}) });
  const facet = new ClickUpConnections({
    clients,
    storage: () => storage,
    intervalSeconds: 60,
    projects: { listAll: async () => projects as never },
    intakeRoutes: () =>
      ({
        listIntakeRoutes: async ({ factoryProjectId }: { factoryProjectId: string }) =>
          Array.from({ length: options.routedLists?.[factoryProjectId] ?? 0 }, (_, index) => ({
            id: `r-${index}`,
            when: { combinator: 'and', conditions: [{ field: 'source.list', operator: 'equals', value: `L-${index}` }] },
          })),
      }) as never,
    intake: {
      ensureReady: async () => {},
      getConfig: async () => intakeConfig as never,
      saveConfig: async ({ config }: { config: unknown }) => void (intakeConfig = config as typeof intakeConfig),
    } as never,
  });
  mountApiRoutes(app, buildConnectionRoutes({ auth, connectors: [{ id: 'clickup', connections: facet }], emitAudit: emitAudit as never }));
  mountApiRoutes(
    app,
    buildClickUpRoutes({
      auth,
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
  const connect = (token?: string) => call('POST', '/web/connections', { connector: 'clickup', method: 'token', input: token === undefined ? {} : { token } });
  return { rows, audits, call, as, connect, calls: clickup.calls, intake: () => intakeConfig };
}

describe('ClickUp connections (ADR-0035)', () => {
  it('connects a checked token for the organization, stores it, and never sends it back', async () => {
    const { call, connect, rows, audits } = setup();
    expect((await call('GET', '/web/clickup/status')).body).toEqual({ configured: false, connected: false, workspaces: [], intervalSeconds: 60, canManage: true });
    expect((await call('GET', '/web/connections')).body.connections).toEqual([]);
    const connected = await connect(' pk_a ');
    expect(connected.status).toBe(200);
    expect(connected.body).toEqual({
      type: 'connected',
      connection: expect.objectContaining({
        id: 'clickup:org',
        connector: { id: 'clickup', name: 'ClickUp', icon: 'clickup' },
        label: 'ann',
        accountLabel: 'ann',
        accountDetail: 'Acme',
        status: 'active',
        state: { tone: 'ok', label: 'Connected' },
        createdBy: 'admin-a',
      }),
      title: 'ClickUp is connected as ann',
      message: 'Workspaces: Acme.',
    });
    expect(JSON.stringify(connected.body)).not.toContain('pk_a');
    expect(rows.get('org-a')).toEqual({
      data: { apiToken: 'pk_a' },
      metadata: { username: 'ann', userId: '1', workspaces: ['Acme'], connectedBy: 'admin-a' },
      userId: 'admin-a',
    });
    expect(audits).toEqual([{ action: 'factory.integration.token_connected', metadata: { replaced: false, account: 'ann' } }]);
    // One token per organization: the catalog says to reconnect instead.
    const methods = (await call('GET', '/web/connections/methods')).body.connectors[0].methods;
    expect(methods[0].available).toEqual({ reason: 'ClickUp is already connected. Replace its token with «Reconnect».' });
  });

  it('refuses a token ClickUp rejects with a message on its field, and keeps the stored one', async () => {
    const { connect, rows } = setup();
    await connect('pk_a');
    const again = await connect('pk_wrong');
    expect(again.status).toBe(422);
    expect(again.body).toMatchObject({ error: 'invalid_token', fields: { token: expect.stringContaining('ClickUp rejected this token (401)') } });
    expect(rows.get('org-a')?.data).toEqual({ apiToken: 'pk_a' });
    expect((await connect()).status).toBe(422);
  });

  it('replaces and deletes the token; the lists then need a new connection', async () => {
    const { call, connect, rows, audits } = setup();
    await connect('pk_a');
    const replaced = await call('POST', '/web/connections/clickup%3Aorg/reconnect', { input: { token: 'pk_b' } });
    expect(replaced.body).toMatchObject({ connection: { accountLabel: 'bob', accountDetail: 'Beta' }, title: 'The token is replaced (bob)' });
    expect((await call('GET', '/web/clickup/lists')).body.lists.map((list: { id: string }) => list.id)).toEqual(['B-1']);
    expect(await call('DELETE', '/web/connections/clickup%3Aorg')).toEqual({ status: 200, body: { removed: true, message: 'Connection deleted' } });
    expect(rows.has('org-a')).toBe(false);
    expect((await call('GET', '/web/clickup/lists')).status).toBe(409);
    expect(audits.map(audit => audit.action)).toEqual([
      'factory.integration.token_connected',
      'factory.integration.token_connected',
      'factory.integration.token_removed',
    ]);
  });

  it('says which Factories stop reading ClickUp Lists before deleting, and deletes only on confirmation', async () => {
    const { call, connect, rows } = setup({ routedLists: { 'fp-1': 2, 'fp-3': 1 } });
    await connect('pk_a');
    const impact = await call('GET', '/web/connections/clickup%3Aorg/impact');
    expect(impact.body).toMatchObject({
      title: 'Delete the “ann” connection?',
      items: [{ label: 'Factory «post-airborne»', outcome: 'stops', outcomeLabel: 'stops reading 2 ClickUp Lists of its intake routes' }],
      requiresConfirm: true,
    });
    expect((await call('GET', '/web/connections')).body.connections[0].dependents).toBe('Read by 1 Factory');
    expect((await call('DELETE', '/web/connections/clickup%3Aorg')).status).toBe(409);
    expect(rows.has('org-a')).toBe(true);
    expect((await call('DELETE', '/web/connections/clickup%3Aorg?confirm=1')).status).toBe(200);
    expect(rows.has('org-a')).toBe(false);
  });

  it('lets only an organization admin connect, replace or delete; members see the state and why not', async () => {
    const { call, connect, as, rows } = setup();
    await connect('pk_a');
    as({ id: 'member-a', organizationId: 'org-a' });
    const [listed] = (await call('GET', '/web/connections')).body.connections;
    expect(listed.actions).toEqual({
      rename: { reason: 'Only organization admins change connections.' },
      reconnect: { reason: 'Only organization admins change connections.' },
      remove: { reason: 'Only organization admins change connections.' },
    });
    expect((await connect('pk_b')).status).toBe(403);
    expect((await call('DELETE', '/web/connections/clickup%3Aorg?confirm=1')).status).toBe(403);
    expect(rows.get('org-a')?.data).toEqual({ apiToken: 'pk_a' });
    as(null);
    expect((await call('GET', '/web/connections')).status).toBe(401);
  });

  it("keeps organizations apart: another organization neither sees nor uses the token, and connects its own", async () => {
    const { call, connect, as, calls } = setup();
    await connect('pk_a');
    as({ id: 'admin-b', organizationId: 'org-b' });
    expect((await call('GET', '/web/connections')).body.connections).toEqual([]);
    expect((await call('GET', '/web/clickup/lists')).status).toBe(409);
    expect((await call('GET', '/web/clickup/lists/A-1/statuses')).status).toBe(409);
    calls.length = 0;
    await connect('pk_b');
    expect((await call('GET', '/web/clickup/lists')).body.lists.map((list: { id: string }) => list.id)).toEqual(['B-1']);
    expect(calls).not.toContain('pk_a');
    as({ id: 'admin-a', organizationId: 'org-a' });
    expect((await call('GET', '/web/clickup/lists')).body.lists.map((list: { id: string }) => list.id)).toEqual(['A-1']);
  });

  it('turns the import on and off from its settings section', async () => {
    const { call, connect, intake } = setup();
    await connect('pk_a');
    const detail = (await call('GET', '/web/connections/clickup%3Aorg/detail')).body;
    expect(detail.sections.find((section: { type: string }) => section.type === 'settings')).toMatchObject({
      id: 'intake',
      fields: [{ name: 'enabled', type: 'boolean', value: false }],
    });
    const saved = await call('PATCH', '/web/connections/clickup%3Aorg/settings', { section: 'intake', values: { enabled: true } });
    expect(saved.body).toEqual({ message: 'ClickUp tasks are imported' });
    expect(intake().clickup).toEqual({ enabled: true, sourceIds: null });
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
    const { call, connect, rows } = setup();
    await connect('pk_a');
    const named = await call('PATCH', '/web/connections/clickup%3Aorg', { name: ' Eclipt ClickUp ' });
    expect(named).toEqual({ status: 200, body: { name: 'Eclipt ClickUp' } });
    expect(rows.get('org-a')?.data).toEqual({ apiToken: 'pk_a' });
    await call('POST', '/web/connections/clickup%3Aorg/reconnect', { input: { token: 'pk_a' } });
    expect((await call('GET', '/web/clickup/status')).body).toMatchObject({ name: 'Eclipt ClickUp', connectedBy: 'admin-a' });
    expect((await call('PATCH', '/web/connections/clickup%3Aorg', { name: '' })).body).toEqual({ name: 'ann' });
    expect((await call('GET', '/web/clickup/status')).body).not.toHaveProperty('name');
  });

  it('lets anyone manage the token when the server runs without sign-in', async () => {
    const isAdmin = vi.fn(async () => false);
    const { connect } = setup({ authEnabled: false, isAdmin });
    expect((await connect('pk_a')).status).toBe(200);
    expect(isAdmin).not.toHaveBeenCalled();
  });
});
