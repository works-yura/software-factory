import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { OPENCODE_HARNESS } from '@factory/contracts';
import type { HarnessUsage } from '@factory/harness/usage';
import { fakeRouteAuth, mountApiRoutes } from '@factory/http/testing';
import { buildConnectionRoutes } from '@factory/integrations';
import { describeConnectorContract } from '@factory/integrations/testing';
import { createFactoryStorageForTests } from '@factory/testing';

import { createOpenCodeAccountsConnections } from './connections.ts';
import type { OpenCodeKeyCheck } from './connections.ts';

const now = new Date('2026-11-14T12:00:00.000Z');
const connector = OPENCODE_HARNESS.setup.accounts!.connector;

/** OpenCode as the key check sees it: a Go key, a Zen key without Go, anything else refused. */
const checkKey = async (key: string): Promise<OpenCodeKeyCheck> =>
  key === 'sk-go' ? { ok: true, go: true } : key === 'sk-zen' ? { ok: true, go: false } : { ok: false, message: 'Invalid API key' };

async function setup() {
  const seed = await createFactoryStorageForTests();
  const facet: HarnessUsage = {
    harnessId: 'opencode',
    displayName: 'OpenCode',
    accountProvider: 'opencode',
    readAccountLimits: async () => ({
      checkedAt: now.toISOString(),
      source: 'probe',
      windows: [{ id: 'go_weekly', kind: 'weekly', usedPercent: 42, resetsAt: '2026-11-17T00:00:00.000Z' }],
    }),
  };
  const connections = createOpenCodeAccountsConnections({ harness: OPENCODE_HARNESS, credentials: seed.credentials, checkKey, usage: { storage: seed.usage, facet }, now: () => now });
  const routes = buildConnectionRoutes({
    auth: fakeRouteAuth({ isOrganizationAdmin: async (_org, user) => user === 'admin' }),
    connectors: [{ id: connector, connections }],
  });
  const send = async (userId: string, method: string, path: string, body?: unknown, language = 'en') => {
    const hono = new Hono();
    hono.use('*', async (c, next) => {
      c.set('factoryAuthUser' as never, { id: userId, organizationId: 'org1' } as never);
      await next();
    });
    mountApiRoutes(hono as never, routes);
    const response = await hono.request(path, {
      method,
      headers: { 'accept-language': language, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: (await response.json()) as any };
  };
  return { seed, send, connections };
}

describe('OpenCode accounts as a connector', () => {
  it('describes itself under «Агенти» with a key method, in the request language', async () => {
    const { send } = await setup();
    const { body } = await send('alice', 'GET', '/web/connections/methods');
    const described = body.connectors.find((entry: { id: string }) => entry.id === connector);
    expect(described).toMatchObject({ name: 'OpenCode', category: 'agents', methods: [{ id: 'api-key', authKind: 'apiKey', available: true }] });
    expect(described.methods[0].fields.map((field: { name: string; type: string }) => [field.name, field.type])).toEqual([
      ['label', 'string'],
      ['key', 'secret'],
    ]);
    const uk = await send('alice', 'GET', '/web/connections/methods', undefined, 'uk');
    expect(uk.body.connectors[0].methods[0].label).toBe('Ключ OpenCode');
  });

  it('keeps a key OpenCode accepts, org-wide and encrypted, and refuses one it does not', async () => {
    const { send, seed } = await setup();
    const refused = await send('alice', 'POST', '/web/connections', { connector, method: 'api-key', input: { key: 'sk-bad' } });
    expect(refused.status).toBe(422);
    expect(refused.body.message).toContain('Invalid API key');
    expect(await seed.credentials.listAccounts('org1', 'opencode')).toHaveLength(0);

    const added = await send('alice', 'POST', '/web/connections', { connector, method: 'api-key', input: { key: 'sk-go', label: 'Team Go' } });
    expect(added.status).toBe(200);
    const [account] = await seed.credentials.listAccounts('org1', 'opencode');
    expect(account).toMatchObject({ label: 'Team Go', kind: 'api_key' });
    expect(await seed.credentials.getAccountSecret('org1', account!.id)).toBe('sk-go');
    expect(JSON.stringify(added.body)).not.toContain('sk-go');
  });

  it('shows the account’s OpenCode Go usage on its page', async () => {
    const { send } = await setup();
    await send('alice', 'POST', '/web/connections', { connector, method: 'api-key', input: { key: 'sk-go' } });
    const { body: list } = await send('alice', 'GET', '/web/connections');
    const id = list.connections.find((connection: { connector: { id: string } }) => connection.connector.id === connector).id;
    const { body } = await send('alice', 'GET', `/web/connections/${encodeURIComponent(id)}/detail`);
    const limits = body.sections.find((section: { type: string; title?: string }) => section.type === 'table');
    expect(limits.title).toBe('OpenCode Go usage');
    expect(limits.rows[0].cells.slice(0, 2)).toEqual(['Week', '42%']);
  });

  it('lets only whoever added it or an admin change or remove it', async () => {
    const { send } = await setup();
    await send('alice', 'POST', '/web/connections', { connector, method: 'api-key', input: { key: 'sk-zen' } });
    const { body: list } = await send('alice', 'GET', '/web/connections');
    const id = list.connections.find((connection: { connector: { id: string } }) => connection.connector.id === connector).id;
    expect((await send('bob', 'DELETE', `/web/connections/${encodeURIComponent(id)}`)).status).toBe(403);
    expect((await send('admin', 'DELETE', `/web/connections/${encodeURIComponent(id)}`)).status).toBe(200);
  });

  describeConnectorContract('OpenCode accounts', async () => {
    const { seed } = await setup();
    await seed.credentials.addAccount({ orgId: 'org1', provider: 'opencode', label: 'Existing', kind: 'api_key', secret: 'sk-existing', createdBy: 'admin' });
    return {
      registration: { id: connector, connections: createOpenCodeAccountsConnections({ harness: OPENCODE_HARNESS, credentials: seed.credentials, checkKey, now: () => now }) },
      orgId: 'org1',
      admin: 'admin',
      member: 'member',
      secrets: ['"sk-existing"', '"sk-zen"'],
      expectsConnections: true,
      connect: { method: 'api-key', input: { key: 'sk-zen' } },
      rename: true,
      remove: true,
    };
  });
});
