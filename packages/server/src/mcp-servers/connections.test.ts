import { LibSQLFactoryStorage } from '@mastra/libsql';
import { Hono } from 'hono';
import { describe, expect, it, onTestFinished } from 'vitest';

import type { McpServerInput } from '@factory/core';
import { fakeRouteAuth, mountApiRoutes } from '@factory/http/testing';
import { buildConnectionRoutes } from '@factory/integrations';
import { describeConnectorContract } from '@factory/integrations/testing';
import { createFactorySecretEncryption, McpServersStorage } from '@factory/store';

import { McpConnections } from './connections.ts';

const own = (name: string, label: string, factories: string[]): McpServerInput => ({
  name,
  label,
  launch: { transport: 'http', url: `https://${name}.example.test/mcp`, headers: {} },
  assignments: factories.map(factoryProjectId => ({ factoryProjectId })),
  toolPolicies: { default: 'allow', tools: {} },
  maskPersonalData: true,
  enabled: true,
});

async function setup(options: { admin?: boolean; reconnect?: { connected: boolean; toolCount: number; errorKind?: 'auth_denied' }; auditEvents?: unknown[] } = {}) {
  const backend = new LibSQLFactoryStorage({ id: 'mcp-connections-test', url: ':memory:' });
  const servers = backend.registerDomain(
    new McpServersStorage(createFactorySecretEncryption({ primary: { id: 'v1', key: new Uint8Array(32).fill(3) } })),
  );
  await backend.init();
  onTestFinished(() => backend.close());
  const audits: string[] = [];
  const facet = new McpConnections({
    servers,
    hub: { reconnect: async () => ({ tools: [], checkedAt: 'now', ...(options.reconnect ?? { connected: true, toolCount: 3 }) }) },
    credentials: { options: async () => ({}) },
    catalog: [],
    projects: { get: async ({ id }) => (['syncts', 'other'].includes(id) ? ({ id, name: id } as never) : null) },
    audit: { record: async input => void audits.push(input.action) },
    ...(options.auditEvents
      ? {
          auditLog: {
            list: async (query: { factoryProjectId?: string }) => ({
              events: (options.auditEvents as Array<{ factoryProjectId: string }>).filter(event => !query.factoryProjectId || event.factoryProjectId === query.factoryProjectId),
            }),
          } as never,
        }
      : {}),
  });
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('factoryAuthUser' as never, { id: 'u1', organizationId: 'org-1' } as never);
    await next();
  });
  mountApiRoutes(app as never, buildConnectionRoutes({ auth: fakeRouteAuth({ isOrganizationAdmin: async () => options.admin ?? true }), connectors: [{ id: 'mcp', connections: facet }] }));
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, { method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}) });
    return { status: res.status, body: (await res.json()) as any };
  };
  const sentry = await servers.create('org-1', own('sentry', 'Sentry', ['syncts', 'other']), 'u1');
  const notes = await servers.create('org-1', own('notes', 'Notes', ['other']), 'u1');
  const managed = await servers.create('org-1', own('db', 'Firestore', ['syncts']), 'u1');
  await servers.update('org-1', managed.id, own('db', 'Firestore', ['syncts']), 'u1');
  return { call, servers, audits, sentry, notes, managed };
}

const Q = '?factoryProjectId=syncts';
const path = (id: string, suffix = '') => `/web/connections/${encodeURIComponent(`mcp:${id}`)}${suffix}${suffix.includes('?') ? '&' : '?'}factoryProjectId=syncts`;

describe('MCP servers as a connector (ADR-0035)', () => {
  it("lists the servers this Factory has access to, as MCP, with the server's words for their state", async () => {
    const { call, sentry } = await setup();
    const { connections } = (await call('GET', `/web/connections${Q}`)).body;
    expect(connections.map((row: any) => row.label).sort()).toEqual(['Firestore', 'Sentry']);
    expect(connections.find((row: any) => row.id === `mcp:${sentry.id}`)).toMatchObject({
      mcp: true,
      scope: 'factory',
      state: { tone: 'idle', label: 'Not checked yet' },
      dependents: 'Factories with access: 2',
      actions: { rename: true, reconnect: { method: expect.objectContaining({ id: 'check', fields: [] }) }, unlink: true, remove: true },
    });
  });

  it('adds through the editor (catalog entries and an own server) or links a server the organization has', async () => {
    const { call, notes, servers } = await setup();
    const [connector] = (await call('GET', `/web/connections/methods${Q}`)).body.connectors;
    expect(connector).toMatchObject({ id: 'mcp', mcp: true, icon: 'mcp' });
    expect(connector.methods.map((method: any) => [method.id, method.editor?.component ?? null])).toEqual([
      ['link', null],
      ['custom', 'mcp-server'],
    ]);
    expect(connector.methods[0].fields[0].options).toEqual([{ value: notes.id, label: 'Notes' }]);
    expect((await call('POST', `/web/connections${Q}`, { connector: 'mcp', method: 'custom' })).status).toBe(400);
    const linked = await call('POST', `/web/connections${Q}`, { connector: 'mcp', method: 'link', input: { serverId: notes.id } });
    expect(linked.body).toMatchObject({ type: 'connected', title: 'Notes is linked to this Factory' });
    expect((await servers.get('org-1', notes.id))?.assignments).toEqual([
      { factoryProjectId: 'other' },
      { factoryProjectId: 'syncts', sessions: ['chat', 'personal', 'cards'] },
    ]);
  });

  it('renames, reconnects, unlinks from this Factory only, and deletes after naming every Factory', async () => {
    const { call, sentry, servers, audits } = await setup();
    expect((await call('PATCH', path(sentry.id), { name: 'Sentry prod' })).body).toEqual({ name: 'Sentry prod' });
    expect((await call('POST', path(sentry.id, '/reconnect'), { input: {} })).body).toMatchObject({ type: 'connected', title: 'Reconnected: 3 tools' });
    const impact = (await call('GET', path(sentry.id, '/impact'))).body;
    expect(impact.dependents).toEqual([{ label: 'Factory «syncts» loses its tools' }, { label: 'Factory «other» loses its tools' }]);
    expect((await call('DELETE', path(sentry.id))).status).toBe(409);
    expect((await call('POST', path(sentry.id, '/unlink'))).status).toBe(200);
    expect((await servers.get('org-1', sentry.id))?.assignments).toEqual([{ factoryProjectId: 'other' }]);
    expect((await call('DELETE', path(sentry.id, '?confirm=1'))).body).toEqual({ removed: true, message: 'Connection deleted' });
    expect(await servers.get('org-1', sentry.id)).toBeNull();
    expect(audits).toEqual(['factory.mcp_server.updated', 'factory.mcp_server.reconnected', 'factory.mcp_server.updated', 'factory.mcp_server.deleted']);
  });

  it("says why a reconnect failed, and gives the editor as the page's one custom section", async () => {
    const { call, sentry } = await setup({ reconnect: { connected: false, toolCount: 0, errorKind: 'auth_denied' } });
    const failed = await call('POST', path(sentry.id, '/reconnect'), { input: {} });
    expect(failed).toEqual({ status: 502, body: { error: 'not_connected', message: expect.stringContaining('The account was refused access') } });
    const { sections } = (await call('GET', path(sentry.id, '/detail'))).body;
    expect(sections.map((section: any) => section.type)).toEqual(['facts', 'custom', 'table']);
    expect(sections[1]).toMatchObject({ component: 'mcp-server', params: { serverId: sentry.id } });
  });

  it('lets only organization admins change servers', async () => {
    const { call, sentry } = await setup({ admin: false });
    expect((await call('PATCH', path(sentry.id), { name: 'x' })).status).toBe(403);
    const [row] = (await call('GET', `/web/connections${Q}`)).body.connections;
    expect(row.actions.remove).toEqual({ reason: 'Only organization admins change connections.' });
  });
});

describe('«Активність» through the registry (ADR-0035)', () => {
  it("serves the Factory's calls through every server, newest first, the server named, deleted ones by the name they had", async () => {
    const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000);
    const events: unknown[] = [];
    const { call, sentry } = await setup({ auditEvents: events });
    const event = (at: Date, outcome: string, factoryProjectId: string, target: string) => ({
      action: 'factory.mcp_server.tool_called',
      targets: [{ type: 'mcp_server', id: target }],
      metadata: { tool: 'list_issues', outcome, sessionId: 'session-1', server: 'gone-db' },
      factoryProjectId,
      occurredAt: at,
    });
    events.push(event(hoursAgo(1), 'ok', 'syncts', sentry.id), event(hoursAgo(2), 'error', 'syncts', 'deleted'), event(hoursAgo(3), 'ok', 'other', sentry.id), event(hoursAgo(30), 'ok', 'syncts', sentry.id));

    const activity = (await call('GET', '/web/connections/activity?factoryProjectId=syncts')).body;
    expect(activity).toMatchObject({ total: 2, errors: 1, truncated: false, failures: [] });
    expect(activity.calls.map((entry: any) => [entry.connectionLabel, entry.outcome, entry.connectionId, entry.connector.id])).toEqual([
      ['Sentry', 'ok', `mcp:${sentry.id}`, 'mcp'],
      ['gone-db', 'error', 'mcp:deleted', 'mcp'],
    ]);
    expect(activity.calls[0]).toMatchObject({ tool: 'list_issues', sessionId: 'session-1', tried: false });
    // Without a Factory there is nothing to show.
    expect((await call('GET', '/web/connections/activity')).body).toMatchObject({ total: 0, calls: [] });
  });
});

// The connector conformance kit (`@factory/integrations/testing`): a Factory's MCP servers, one with a secret header.
describeConnectorContract('MCP servers', async () => {
  const backend = new LibSQLFactoryStorage({ id: 'mcp-connections-contract', url: ':memory:' });
  const servers = backend.registerDomain(new McpServersStorage(createFactorySecretEncryption({ primary: { id: 'v1', key: new Uint8Array(32).fill(3) } })));
  await backend.init();
  onTestFinished(() => backend.close());
  const secret = 'Bearer mcp-contract-secret';
  await servers.create('org-1', { ...own('sentry', 'Sentry', ['syncts']), launch: { transport: 'http', url: 'https://sentry.example.test/mcp', headers: { Authorization: secret } } }, 'u1');
  await servers.create('org-1', own('notes', 'Notes', ['other']), 'u1');
  return {
    registration: {
      id: 'mcp',
      connections: new McpConnections({
        servers,
        hub: { reconnect: async () => ({ tools: [], checkedAt: 'now', connected: true, toolCount: 3 }) },
        credentials: { options: async () => ({}) },
        catalog: [],
        projects: { get: async ({ id }) => (['syncts', 'other'].includes(id) ? ({ id, name: id } as never) : null) },
        audit: { record: async () => {} },
      }),
    },
    orgId: 'org-1',
    admin: 'admin',
    member: 'member',
    factoryProjectId: 'syncts',
    secrets: [secret],
    expectsConnections: true,
    rename: true,
    remove: true,
  };
});
