import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { fakeRouteAuth, mountApiRoutes } from '@factory/http/testing';

import { buildConnectionRoutes, connectionLanguage, connectionOk, connectionRefused } from './connections.ts';
import type { ConnectionRequest, ConnectorConnection, IntegrationConnections } from './connections.ts';

const CAPABILITIES = { multipleConnectionsPerToolkit: true, batchConnectionStatus: false, reauthorizeReusesConnectionId: true };

/** A connector the registry knows nothing about beyond its facet. */
function fakeConnector(calls: Array<{ call: string; request: ConnectionRequest; args: unknown[] }>): IntegrationConnections {
  const connection = (request: ConnectionRequest): ConnectorConnection => ({
    id: 'one',
    label: request.language === 'uk' ? 'Перше' : 'First',
    status: 'active',
    displayName: null,
    accountLabel: null,
    provides: [{ key: 'tools', label: 'Tools' }],
    state: { tone: 'ok', label: 'OK' },
    scope: 'organization',
    actions: { rename: true, remove: true },
  });
  return {
    describe: request => ({
      name: 'Fake',
      icon: 'fake',
      category: 'tools',
      provides: [],
      capabilities: CAPABILITIES,
      methods: [{ id: 'key', label: request.language === 'uk' ? 'Ключ' : 'Key', authKind: 'apiKey', fields: [], available: true }],
    }),
    list: async request => [connection(request)],
    connect: async (request, method, input) => {
      calls.push({ call: 'connect', request, args: [method, input] });
      return input.key === 'bad'
        ? connectionRefused(422, { error: 'invalid', message: 'Bad key', fields: { key: 'Bad key' } })
        : connectionOk({ type: 'connected', connection: connection(request), title: 'Connected' });
    },
    getAuthStatus: async (_request, authId) => (authId === 'flow-1' ? 'completed' : null),
    remove: async (request, id, options) => {
      calls.push({ call: 'remove', request, args: [id, options] });
      return options.confirm
        ? connectionOk({ message: 'Removed' })
        : connectionRefused(409, { error: 'in_use', message: 'Confirm' });
    },
  };
}

function app(options: { admin?: boolean; orgId?: string | null; failing?: boolean } = {}) {
  const calls: Array<{ call: string; request: ConnectionRequest; args: unknown[] }> = [];
  const audits: unknown[] = [];
  const broken: IntegrationConnections = {
    ...fakeConnector(calls),
    describe: () => ({ name: 'Broken', icon: 'broken', category: 'sources', provides: [], capabilities: CAPABILITIES, methods: [] }),
    list: async () => {
      throw new Error('storage down');
    },
  };
  const routes = buildConnectionRoutes({
    auth: fakeRouteAuth({ isOrganizationAdmin: async () => options.admin ?? true }),
    connectors: [{ id: 'fake', connections: fakeConnector(calls) }, ...(options.failing ? [{ id: 'broken', connections: broken }] : [])],
    emitAudit: async args => void audits.push(args.input),
  });
  const request = (path: string, init?: RequestInit) => {
    const hono = new Hono();
    hono.use('*', async (c, next) => {
      if (options.orgId !== null) c.set('factoryAuthUser' as never, { id: 'user-1', organizationId: options.orgId ?? 'org-1' } as never);
      await next();
    });
    mountApiRoutes(hono as never, routes);
    return hono.request(path, init);
  };
  const json = (method: string, body: unknown, headers: Record<string, string> = {}) => ({
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { request, json, calls, audits };
}

describe('connectionLanguage', () => {
  it('takes the first supported language of Accept-Language, English otherwise', () => {
    expect(connectionLanguage('uk-UA,uk;q=0.9,en;q=0.8')).toBe('uk');
    expect(connectionLanguage('de-DE,en;q=0.5')).toBe('en');
    expect(connectionLanguage('fr')).toBe('en');
    expect(connectionLanguage(undefined)).toBe('en');
  });
});

describe('/web/connections', () => {
  it('lists every connector’s connections under global ids, in the request’s language, naming a connector that failed', async () => {
    const t = app({ failing: true });
    const body = (await (await t.request('/web/connections?factoryProjectId=f-1', { headers: { 'accept-language': 'uk' } })).json()) as any;
    expect(body.connections).toEqual([
      expect.objectContaining({ id: 'fake:one', connector: { id: 'fake', name: 'Fake', icon: 'fake' }, label: 'Перше' }),
    ]);
    expect(body.failures).toEqual([{ connector: { id: 'broken', name: 'Broken', icon: 'broken' }, message: expect.stringContaining('storage down') }]);
    expect(body.copy.organizationWide).toBe('Уся організація');
  });

  it('describes the connectors’ methods for the catalog', async () => {
    const body = (await (await app().request('/web/connections/methods')).json()) as any;
    expect(body.connectors).toEqual([expect.objectContaining({ id: 'fake', methods: [expect.objectContaining({ id: 'key', label: 'Key' })] })]);
  });

  it('connects through the named connector and method, passing field errors through', async () => {
    const t = app();
    const ok = await t.request('/web/connections', t.json('POST', { connector: 'fake', method: 'key', input: { key: 'good' } }));
    expect(await ok.json()).toMatchObject({ type: 'connected', connection: { id: 'fake:one', connector: { id: 'fake' } } });
    expect(t.calls[0]).toMatchObject({ call: 'connect', request: { orgId: 'org-1', userId: 'user-1', admin: true }, args: ['key', { key: 'good' }] });
    const bad = await t.request('/web/connections', t.json('POST', { connector: 'fake', method: 'key', input: { key: 'bad' } }));
    expect(bad.status).toBe(422);
    expect(await bad.json()).toEqual({ error: 'invalid', message: 'Bad key', fields: { key: 'Bad key' } });
    expect((await t.request('/web/connections', t.json('POST', { connector: 'nope', method: 'x' }))).status).toBe(404);
    expect((await t.request('/web/connections', t.json('POST', { nothing: true }))).status).toBe(400);
  });

  it('lets only organization admins change connections; members still read them', async () => {
    const t = app({ admin: false });
    expect((await t.request('/web/connections')).status).toBe(200);
    const refused = await t.request('/web/connections', t.json('POST', { connector: 'fake', method: 'key', input: {} }, { 'accept-language': 'uk' }));
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: 'forbidden', message: 'Змінювати підключення можуть лише адміністратори організації.' });
    expect((await t.request('/web/connections/fake%3Aone', { method: 'DELETE' })).status).toBe(403);
    expect(t.calls).toEqual([]);
  });

  it('removes only with confirmation when the connector asks for it, and refuses what a connector cannot do', async () => {
    const t = app();
    expect((await t.request('/web/connections/fake%3Aone', { method: 'DELETE' })).status).toBe(409);
    expect(await (await t.request('/web/connections/fake%3Aone?confirm=1', { method: 'DELETE' })).json()).toEqual({ removed: true, message: 'Removed' });
    expect(t.calls.map(call => call.args)).toEqual([
      ['one', { confirm: false }],
      ['one', { confirm: true }],
    ]);
    expect((await t.request('/web/connections/fake%3Aone', t.json('PATCH', { name: 'x' }))).status).toBe(409);
    expect((await t.request('/web/connections/unknown%3Aone/impact')).status).toBe(404);
    expect((await t.request('/web/connections/fake%3Aone/detail')).status).toBe(200);
  });

  it('reports an authorize flow’s status by its authId, as Mastra’s getAuthStatus', async () => {
    const t = app();
    expect(await (await t.request('/web/connections/authorizations/flow-1?connector=fake')).json()).toEqual({ status: 'completed' });
    expect((await t.request('/web/connections/authorizations/other?connector=fake')).status).toBe(404);
    expect((await t.request('/web/connections/authorizations/flow-1?connector=nope')).status).toBe(404);
  });

  it('refuses a request without an organization', async () => {
    expect((await app({ orgId: null }).request('/web/connections')).status).toBe(401);
    expect((await app({ orgId: '' }).request('/web/connections')).status).toBe(403);
  });
});
