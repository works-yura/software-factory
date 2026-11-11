import { LibSQLFactoryStorage } from '@mastra/libsql';
import { Hono } from 'hono';
import { describe, expect, it, onTestFinished } from 'vitest';

import { fakeRouteAuth, mountApiRoutes } from '@factory/http/testing';
import type { TestAuthUser } from '@factory/http/testing';
import { createFactorySecretEncryption, McpServersStorage } from '@factory/store';

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
      },
      credentials: {
        options: async () => ({ 'google-cloud-account': [{ id: 'acc-1', name: 'Syncta', detail: 'factory@syncta-57c6a.iam.gserviceaccount.com' }] }),
        suggestions: async (_org, factoryProjectId) => (factoryProjectId === 'syncts' ? { 'google-cloud-project': 'syncta-57c6a' } : {}),
      },
      audit: { record: async input => void audits.push({ action: input.action }) },
    }),
  );
  const call = (method: string, path: string, body?: unknown) =>
    app.request(path, { method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}) });
  return { call, audits, checked, servers };
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
});
