import { LibSQLFactoryStorage } from '@mastra/libsql';
import { Hono } from 'hono';
import { describe, expect, it, onTestFinished } from 'vitest';

import { fakeRouteAuth, mountApiRoutes } from '@factory/http/testing';
import type { TestAuthUser } from '@factory/http/testing';
import { createFactorySecretEncryption, McpServersStorage } from '@factory/store';

import { McpToolNotTryableError } from './hub.ts';
import { buildMcpServerRoutes } from './routes.ts';

const admin: TestAuthUser = { id: 'u1', organizationId: 'org-1' };

async function setup(options: { isAdmin?: boolean; user?: TestAuthUser } = {}) {
  const backend = new LibSQLFactoryStorage({ id: 'mcp-routes-test', url: ':memory:' });
  const servers = backend.registerDomain(
    new McpServersStorage(createFactorySecretEncryption({ primary: { id: 'v1', key: new Uint8Array(32).fill(3) } })),
  );
  await backend.init();
  onTestFinished(() => backend.close());
  const audits: Array<{ action: string }> = [];
  const checked: string[] = [];
  const dryRuns: Array<{ name: string; launch: unknown; secrets: unknown }> = [];
  const discoveries: Array<{ credential: unknown; source: string; context: unknown }> = [];
  const reconnected: string[] = [];
  const auditEvents: Array<{
    actorId: string;
    actorType: string;
    action: string;
    targets: Array<{ type: string; id: string }>;
    metadata: Record<string, unknown>;
    factoryProjectId: string | null;
    occurredAt: Date;
  }> = [];
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('factoryAuthUser' as never, (options.user ?? admin) as never);
    await next();
  });
  mountApiRoutes(
    app,
    buildMcpServerRoutes({
      auth: fakeRouteAuth({ isOrganizationAdmin: async () => options.isAdmin ?? true }),
      servers,
      hub: {
        status: async (_org, id) => {
          checked.push(id);
          return { connected: true, toolCount: 1, tools: [{ name: 'list_collections', description: '', policy: 'allow' }], checkedAt: 'now' };
        },
        check: async (_org, record) => {
          dryRuns.push({ name: record.name, launch: record.launch, secrets: record.secrets });
          return { connected: true, toolCount: 2, tools: [{ name: 'list_collections', description: '', policy: 'allow' }, { name: 'delete_documents', description: '', policy: 'allow' }], checkedAt: 'now' };
        },
        reconnect: async (_org, id) => {
          reconnected.push(id);
          return { connected: true, toolCount: 1, tools: [], checkedAt: 'now' };
        },
        tryTool: async (_org, id, tool, args) => {
          if (tool === 'delete_documents') throw new McpToolNotTryableError('not_read_only', 'not read-only');
          return { ok: true, output: { id, tool, args }, durationMs: 5 };
        },
      },
      auditLog: { list: async () => ({ events: auditEvents }) },
      credentials: {
        options: async () => ({ 'google-cloud-account': [{ id: 'acc-1', name: 'Syncta', detail: 'factory@syncta-57c6a.iam.gserviceaccount.com' }] }),
        suggestions: async (_org, factoryProjectId) => (factoryProjectId === 'syncts' ? { 'google-cloud-project': 'syncta-57c6a' } : {}),
        discover: async (_org, credential, source, context) => {
          discoveries.push({ credential, source, context });
          return source === 'google-cloud-projects'
            ? { items: [{ value: 'syncta-57c6a' }], default: 'syncta-57c6a', denied: { role: 'roles/datastore.viewer', message: 'refused' } }
            : { items: [{ value: '(default)' }], default: '(default)' };
        },
      },
      audit: { record: async input => void audits.push({ action: input.action }) },
    }),
  );
  const call = (method: string, path: string, body?: unknown) =>
    app.request(path, { method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}) });
  return { call, audits, checked, servers, dryRuns, discoveries, reconnected, auditEvents };
}

const firestore = {
  name: 'syncta-db',
  label: 'Syncta Firestore',
  launch: {
    transport: 'catalog',
    entry: 'mcp-toolbox',
    variant: 'firestore',
    inputs: { FIRESTORE_PROJECT: 'syncta-57c6a' },
    credentials: { GOOGLE_APPLICATION_CREDENTIALS: { kind: 'google-cloud-account', id: 'acc-1' } },
  },
  assignments: [{ factoryProjectId: 'syncts', boards: ['audits'] }],
};

describe('MCP server routes: status, try, reconnect, calls', () => {
  it('tries a read-only tool for an admin, refuses a writing one and a member', async () => {
    const { call } = await setup();
    const { server } = await (await call('POST', '/web/mcp-servers', firestore)).json();
    const ok = await call('POST', `/web/mcp-servers/${server.id}/try`, { tool: 'list_collections', arguments: { limit: 1 } });
    expect(ok.status).toBe(200);
    expect((await ok.json()).trial).toMatchObject({ ok: true, output: { tool: 'list_collections', args: { limit: 1 } } });

    const writing = await call('POST', `/web/mcp-servers/${server.id}/try`, { tool: 'delete_documents' });
    expect(writing.status).toBe(422);
    expect(await writing.json()).toMatchObject({ error: 'not_read_only' });

    const member = await setup({ isAdmin: false });
    const { server: other } = await (await call('POST', '/web/mcp-servers', { ...firestore, name: 'other-db' })).json();
    expect((await member.call('POST', `/web/mcp-servers/${other.id}/try`, { tool: 'list_collections' })).status).toBe(403);
  });

  it('reconnects a server and audits it', async () => {
    const { call, reconnected, audits } = await setup();
    const { server } = await (await call('POST', '/web/mcp-servers', firestore)).json();
    const res = await call('POST', `/web/mcp-servers/${server.id}/reconnect`);
    expect(res.status).toBe(200);
    expect(reconnected).toEqual([server.id]);
    expect(audits.map(a => a.action)).toContain('factory.mcp_server.reconnected');
  });

  it('lists the server’s recent calls from the audit trail, newest first, without payloads', async () => {
    const { call, auditEvents } = await setup();
    const { server } = await (await call('POST', '/web/mcp-servers', firestore)).json();
    const at = (minute: number) => new Date(Date.UTC(2026, 10, 12, 10, minute));
    auditEvents.push(
      {
        actorId: 'session-1',
        actorType: 'agent',
        action: 'factory.mcp_server.tool_called',
        targets: [{ type: 'mcp_server', id: server.id }],
        metadata: { tool: 'list_collections', outcome: 'ok', durationMs: 120, sessionId: 'session-1' },
        factoryProjectId: 'syncts',
        occurredAt: at(5),
      },
      {
        actorId: 'u1',
        actorType: 'human',
        action: 'factory.mcp_server.tool_tried',
        targets: [{ type: 'mcp_server', id: server.id }],
        metadata: { tool: 'get_documents', outcome: 'error', durationMs: 900 },
        factoryProjectId: 'syncts',
        occurredAt: at(4),
      },
      {
        actorId: 'session-2',
        actorType: 'agent',
        action: 'factory.mcp_server.tool_called',
        targets: [{ type: 'mcp_server', id: 'another-server' }],
        metadata: { tool: 'x', outcome: 'ok' },
        factoryProjectId: 'syncts',
        occurredAt: at(3),
      },
    );
    const { calls } = await (await call('GET', `/web/mcp-servers/${server.id}/calls`)).json();
    expect(calls).toEqual([
      { at: at(5).toISOString(), tool: 'list_collections', outcome: 'ok', durationMs: 120, sessionId: 'session-1', factoryProjectId: 'syncts', tried: false },
      { at: at(4).toISOString(), tool: 'get_documents', outcome: 'error', durationMs: 900, factoryProjectId: 'syncts', tried: true },
    ]);
  });
});

describe('MCP server routes', () => {
  it('creates, lists, changes and deletes a server; secret values never come back', async () => {
    const { call, audits } = await setup();
    const created = await call('POST', '/web/mcp-servers', firestore);
    expect(created.status).toBe(201);
    const { server } = await created.json();
    expect(server).toMatchObject({
      name: 'syncta-db',
      launch: { credentials: { GOOGLE_APPLICATION_CREDENTIALS: { kind: 'google-cloud-account', id: 'acc-1' } } },
      toolPolicies: { default: 'allow', tools: {} },
      maskPersonalData: true,
    });

    const list = await call('GET', '/web/mcp-servers');
    expect(list.headers.get('cache-control')).toBe('no-store');
    const listed = await list.json();
    expect(listed.servers).toHaveLength(1);
    expect(listed.catalog.map((entry: { id: string }) => entry.id)).toEqual(['mcp-toolbox']);
    expect(listed.credentials['google-cloud-account']).toEqual([
      { id: 'acc-1', name: 'Syncta', detail: 'factory@syncta-57c6a.iam.gserviceaccount.com' },
    ]);
    expect(JSON.stringify(listed.catalog)).not.toContain('node_modules');

    const updated = await call('PUT', `/web/mcp-servers/${server.id}`, {
      ...firestore,
      secrets: undefined,
      toolPolicies: { default: 'allow', tools: { delete_documents: 'deny' } },
    });
    expect((await updated.json()).server).toMatchObject({
      toolPolicies: { tools: { delete_documents: 'deny' } },
    });

    expect((await call('DELETE', `/web/mcp-servers/${server.id}`)).status).toBe(200);
    expect((await call('DELETE', `/web/mcp-servers/${server.id}`)).status).toBe(404);
    expect(audits.map(audit => audit.action)).toEqual([
      'factory.mcp_server.created',
      'factory.mcp_server.updated',
      'factory.mcp_server.deleted',
    ]);
  });

  it('checks a server on request', async () => {
    const { call, checked } = await setup();
    const { server } = await (await call('POST', '/web/mcp-servers', firestore)).json();
    const status = await call('POST', `/web/mcp-servers/${server.id}/status`);
    expect((await status.json()).status).toMatchObject({ connected: true, toolCount: 1 });
    expect(checked).toEqual([server.id]);
  });

  it('keeps a secret input’s value and never returns it', async () => {
    const { call } = await setup();
    const postgres = {
      name: 'reports-db',
      label: 'Reports',
      launch: { transport: 'catalog', entry: 'mcp-toolbox', variant: 'postgres', inputs: { POSTGRES_DATABASE: 'r', POSTGRES_USER: 'reader' } },
      secrets: { env: { POSTGRES_PASSWORD: 'hunter2-secret' } },
    };
    const created = await call('POST', '/web/mcp-servers', postgres);
    const body = await created.text();
    expect(created.status).toBe(201);
    expect(body).not.toContain('hunter2-secret');
    expect(JSON.parse(body).server.secretNames.env).toEqual(['POSTGRES_PASSWORD']);
  });

  it('suggests the Factory’s Google Cloud project for a catalog input', async () => {
    const { call } = await setup();
    const response = await call('GET', '/web/mcp-servers/suggestions?factoryProjectId=syncts');
    expect((await response.json()).suggestions).toEqual({ 'google-cloud-project': 'syncta-57c6a' });
    expect((await call('GET', '/web/mcp-servers/suggestions')).status).toBe(400);
  });

  it('refuses a catalog launch with an unknown entry, way to run, input or credential kind', async () => {
    const { call } = await setup();
    const launch = firestore.launch;
    for (const bad of [
      { ...launch, entry: 'nope' },
      { ...launch, variant: 'mysql' },
      { ...launch, inputs: { NOT_AN_INPUT: 'x' } },
      { ...launch, credentials: { FIRESTORE_PROJECT: { kind: 'google-cloud-account', id: 'acc-1' } } },
    ]) {
      const response = await call('POST', '/web/mcp-servers', { ...firestore, launch: bad });
      expect(response.status).toBe(422);
    }
  });

  it('refuses an invalid server, a taken name, and writes by someone who is not an admin', async () => {
    const { call } = await setup();
    expect((await call('POST', '/web/mcp-servers', { ...firestore, name: 'Bad Name' })).status).toBe(422);
    await call('POST', '/web/mcp-servers', firestore);
    expect((await call('POST', '/web/mcp-servers', firestore)).status).toBe(409);

    const member = await setup({ isAdmin: false });
    expect((await member.call('POST', '/web/mcp-servers', firestore)).status).toBe(403);
    expect((await (await member.call('GET', '/web/mcp-servers')).json()).canEdit).toBe(false);
  });

  it('lets a person change only the tool policy and masking of a server an integration manages, and not delete it', async () => {
    const { call, servers } = await setup();
    await servers.syncOwned(
      'org-1',
      'firebase',
      [{ key: 'bnd-1', name: 'db-syncta-57c6a', label: 'Firestore syncta-57c6a', launch: firestore.launch as never, assignments: [{ factoryProjectId: 'syncts' }] }],
      'integration:firebase',
    );
    const [managed] = await servers.list('org-1');

    const changed = await call('PUT', `/web/mcp-servers/${managed!.id}`, {
      ...firestore,
      name: 'renamed',
      assignments: [{ factoryProjectId: 'other' }],
      toolPolicies: { default: 'allow', tools: { delete_documents: 'deny' } },
      maskPersonalData: false,
      enabled: false,
    });
    expect(changed.status).toBe(200);
    expect((await changed.json()).server).toMatchObject({
      name: 'db-syncta-57c6a',
      assignments: [{ factoryProjectId: 'syncts' }],
      toolPolicies: { tools: { delete_documents: 'deny' } },
      maskPersonalData: false,
      enabled: true,
      owner: { integration: 'firebase', key: 'bnd-1' },
    });

    const deleted = await call('DELETE', `/web/mcp-servers/${managed!.id}`);
    expect(deleted.status).toBe(409);
    expect(await deleted.json()).toMatchObject({ error: 'managed_by_integration', integration: 'firebase' });
  });

  it('looks up an input’s choices with the picked account, passing a refusal on as a hint', async () => {
    const { call, discoveries } = await setup({ isAdmin: false });
    const projects = await call('POST', '/web/mcp-servers/discover', {
      credential: { kind: 'google-cloud-account', id: 'acc-1' },
      from: 'google-cloud-projects',
    });
    expect(projects.status).toBe(200);
    expect(await projects.json()).toEqual({ items: [{ value: 'syncta-57c6a' }], default: 'syncta-57c6a', denied: { role: 'roles/datastore.viewer', message: 'refused' } });
    const databases = await call('POST', '/web/mcp-servers/discover', {
      credential: { kind: 'google-cloud-account', id: 'acc-1' },
      from: 'firestore-databases',
      context: { project: 'syncta-57c6a' },
    });
    expect((await databases.json()).default).toBe('(default)');
    expect(discoveries[1]).toEqual({ credential: { kind: 'google-cloud-account', id: 'acc-1' }, source: 'firestore-databases', context: { project: 'syncta-57c6a' } });
    expect((await call('POST', '/web/mcp-servers/discover', { credential: { kind: 'google-cloud-account', id: 'acc-1' }, from: 'nowhere' })).status).toBe(422);
  });

  it('checks a server before it is saved, with the stored secrets of the one being edited, storing nothing', async () => {
    const { call, dryRuns, servers } = await setup();
    const unsaved = await call('POST', '/web/mcp-servers/check', { server: firestore });
    expect(unsaved.status).toBe(200);
    expect((await unsaved.json()).status.tools.map((tool: { name: string }) => tool.name)).toEqual(['list_collections', 'delete_documents']);
    expect(dryRuns[0]).toMatchObject({ name: 'syncta-db', launch: { credentials: { GOOGLE_APPLICATION_CREDENTIALS: { id: 'acc-1' } } } });
    expect(await servers.list('org-1')).toEqual([]);

    const custom = { name: 'own', label: 'Own', launch: { transport: 'stdio', command: 'node', args: [], env: {} }, assignments: [] };
    const { server } = await (await call('POST', '/web/mcp-servers', { ...custom, secrets: { env: { TOKEN: 'saved-secret' } } })).json();
    await call('POST', '/web/mcp-servers/check', { id: server.id, server: custom });
    expect(dryRuns[1]).toMatchObject({ secrets: { env: { TOKEN: 'saved-secret' } } });
    await call('POST', '/web/mcp-servers/check', { id: server.id, server: { ...custom, secrets: { env: { TOKEN: 'typed-now' } } } });
    expect(dryRuns[2]).toMatchObject({ secrets: { env: { TOKEN: 'typed-now' } } });
    expect((await call('POST', '/web/mcp-servers/check', { id: 'missing', server: custom })).status).toBe(404);
    expect((await call('POST', '/web/mcp-servers/check', { server: { name: 'BAD NAME' } })).status).toBe(422);
  });

  it('refuses a member the pre-save check: it starts a process', async () => {
    const { call } = await setup({ isAdmin: false });
    expect((await call('POST', '/web/mcp-servers/check', { server: firestore })).status).toBe(403);
  });
});
