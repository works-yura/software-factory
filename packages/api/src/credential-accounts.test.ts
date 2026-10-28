import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { createFactoryStorageForTests } from '@factory/testing';
import { fakeRouteAuth, mountApiRoutes } from '@factory/http/testing';

import { CredentialAccountRoutes } from './credential-accounts.ts';

const apiKey = 'sk-ant-api03-aaaaaaaaaaaaaaaaaaaa1111';
const aliceToken = 'sk-ant-oat01-bbbbbbbbbbbbbbbbbbbb2222';
const now = new Date('2026-10-28T12:00:00Z');
const BASE = '/web/config/providers/anthropic/accounts';

async function setup() {
  const seed = await createFactoryStorageForTests();
  const admins = new Set(['admin']);
  const app = (userId: string | null, orgId = 'org1') => {
    const hono = new Hono();
    hono.use('*', async (c, next) => {
      if (userId) c.set('factoryAuthUser' as never, { workosId: userId, organizationId: orgId } as never);
      await next();
    });
    mountApiRoutes(
      hono as never,
      new CredentialAccountRoutes({
        auth: fakeRouteAuth({ isOrganizationAdmin: async (_org, user) => admins.has(user) }),
        modelCredentials: seed.credentials,
        now: () => now,
      }).routes(),
    );
    return hono;
  };
  const send = async (userId: string | null, method: string, path: string, body?: unknown) => {
    const response = await app(userId).request(path, {
      method,
      ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
    });
    return { status: response.status, body: (await response.json()) as any };
  };
  return { seed, send };
}

describe('credential account routes', () => {
  it('lets a member add their own subscription and never returns a secret', async () => {
    const { send } = await setup();
    const created = await send('alice', 'POST', BASE, { label: 'Alice Max', secret: aliceToken });
    expect(created.status).toBe(201);
    expect(created.body.account).toMatchObject({
      label: 'Alice Max',
      kind: 'subscription',
      mine: true,
      status: 'active',
      hint: '2222',
      canManage: true,
      canReplaceSecret: true,
    });

    const listed = await send('bob', 'GET', BASE);
    expect(listed.status).toBe(200);
    expect(listed.body.canAddOrgKeys).toBe(false);
    expect(listed.body.accounts[0]).toMatchObject({ mine: false, canManage: false, canReplaceSecret: false });
    expect(JSON.stringify(listed.body)).not.toContain(aliceToken);
  });

  it('keeps organization API keys to admins', async () => {
    const { send } = await setup();
    expect((await send('bob', 'POST', BASE, { label: 'Team', secret: apiKey })).status).toBe(403);
    const created = await send('admin', 'POST', BASE, { label: 'Team', secret: apiKey, priority: 2 });
    expect(created.status).toBe(201);
    expect(created.body.account).toMatchObject({ kind: 'api_key', priority: 2, mine: false, canManage: true });
  });

  it('validates input', async () => {
    const { send } = await setup();
    expect((await send('alice', 'POST', BASE, { label: '', secret: aliceToken })).status).toBe(400);
    expect((await send('alice', 'POST', BASE, { label: 'x', secret: 'short' })).status).toBe(400);
    expect((await send('alice', 'POST', BASE, { label: 'x', secret: `${aliceToken} extra` })).status).toBe(400);
    expect((await send('alice', 'POST', BASE, { label: 'x', secret: aliceToken, owner: 'bob' })).status).toBe(400);
    expect((await send('alice', 'POST', '/web/config/providers/openai/accounts', { label: 'x', secret: apiKey })).status).toBe(
      400,
    );
  });

  it('needs a signed-in caller', async () => {
    const { send } = await setup();
    expect((await send(null, 'GET', BASE)).status).toBe(401);
  });

  it('lets only the owner replace a subscription’s secret, and keeps its kind', async () => {
    const { send } = await setup();
    const { body } = await send('alice', 'POST', BASE, { label: 'Alice Max', secret: aliceToken });
    const path = `${BASE}/${body.account.id}`;

    expect((await send('bob', 'PATCH', path, { label: 'mine now' })).status).toBe(403);
    expect((await send('admin', 'PATCH', path, { secret: 'sk-ant-oat01-cccccccccccccccccccc3333' })).status).toBe(403);
    expect((await send('alice', 'PATCH', path, { secret: apiKey })).status).toBe(400);
    const replaced = await send('alice', 'PATCH', path, { secret: 'sk-ant-oat01-cccccccccccccccccccc3333' });
    expect(replaced.body.account).toMatchObject({ hint: '3333', status: 'active' });
    // An admin may still switch it off.
    expect((await send('admin', 'PATCH', path, { disabled: true })).body.account.status).toBe('disabled');
  });

  it('shows a limited account with its reset and clears it when switched back on', async () => {
    const { send, seed } = await setup();
    const { body } = await send('admin', 'POST', BASE, { label: 'Team', secret: apiKey });
    const until = new Date(now.getTime() + 3_600_000);
    await seed.credentials.markAccountLimited('org1', body.account.id, { until, error: '5-hour limit reached' });

    const listed = await send('admin', 'GET', BASE);
    expect(listed.body.accounts[0]).toMatchObject({
      status: 'limited',
      limitedUntil: until.toISOString(),
      lastError: '5-hour limit reached',
    });
    const enabled = await send('admin', 'PATCH', `${BASE}/${body.account.id}`, { disabled: false });
    expect(enabled.body.account.status).toBe('active');
    expect(enabled.body.account.limitedUntil).toBeUndefined();
  });

  it('removes an account for its owner or an admin, within the organization only', async () => {
    const { send } = await setup();
    const { body } = await send('alice', 'POST', BASE, { label: 'Alice Max', secret: aliceToken });
    const path = `${BASE}/${body.account.id}`;

    expect((await send('bob', 'DELETE', path)).status).toBe(403);
    expect((await send('alice', 'DELETE', `${BASE}/00000000-0000-4000-8000-000000000000`)).status).toBe(404);
    expect((await send('alice', 'DELETE', path)).status).toBe(200);
    expect((await send('alice', 'GET', BASE)).body.accounts).toEqual([]);
  });
});
