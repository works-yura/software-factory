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
      audit: { record: async input => void audits.push({ action: input.action }) },
    }),
  );
  const call = (method: string, path: string, body?: unknown) =>
    app.request(path, { method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}) });
  return { call, audits, checked };
}

const firestore = {
  name: 'syncta-db',
  label: 'Syncta Firestore',
  launch: { transport: 'stdio', preset: 'toolbox-firestore', env: { FIRESTORE_PROJECT: 'syncta-57c6a' } },
  secrets: { files: { GOOGLE_APPLICATION_CREDENTIALS: '{"private_key":"-----BEGIN PRIVATE KEY-----x"}' } },
  assignments: [{ factoryProjectId: 'syncts', boards: ['audits'] }],
};

describe('MCP server routes', () => {
  it('creates, lists, changes and deletes a server; secret values never come back', async () => {
    const { call, audits } = await setup();
    const created = await call('POST', '/web/mcp-servers', firestore);
    expect(created.status).toBe(201);
    const body = await created.text();
    expect(body).not.toContain('PRIVATE KEY');
    const { server } = JSON.parse(body);
    expect(server).toMatchObject({
      name: 'syncta-db',
      secretNames: { files: ['GOOGLE_APPLICATION_CREDENTIALS'] },
      toolPolicies: { default: 'allow', tools: {} },
      maskPersonalData: true,
    });

    const list = await call('GET', '/web/mcp-servers');
    expect(list.headers.get('cache-control')).toBe('no-store');
    const listed = await list.json();
    expect(listed.servers).toHaveLength(1);
    expect(listed.presets.map((preset: { id: string }) => preset.id)).toContain('toolbox-firestore');
    expect(JSON.stringify(listed)).not.toContain('PRIVATE KEY');
    expect(JSON.stringify(listed.presets)).not.toContain('node_modules');

    const updated = await call('PUT', `/web/mcp-servers/${server.id}`, {
      ...firestore,
      secrets: undefined,
      toolPolicies: { default: 'allow', tools: { delete_documents: 'deny' } },
    });
    expect((await updated.json()).server).toMatchObject({
      toolPolicies: { tools: { delete_documents: 'deny' } },
      // A write without secrets keeps the stored ones.
      secretNames: { files: ['GOOGLE_APPLICATION_CREDENTIALS'] },
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

  it('refuses an invalid server, a taken name, and writes by someone who is not an admin', async () => {
    const { call } = await setup();
    expect((await call('POST', '/web/mcp-servers', { ...firestore, name: 'Bad Name' })).status).toBe(422);
    await call('POST', '/web/mcp-servers', firestore);
    expect((await call('POST', '/web/mcp-servers', firestore)).status).toBe(409);

    const member = await setup({ isAdmin: false });
    expect((await member.call('POST', '/web/mcp-servers', firestore)).status).toBe(403);
    expect((await (await member.call('GET', '/web/mcp-servers')).json()).canEdit).toBe(false);
  });
});
