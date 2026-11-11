import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { createFactoryStorageForTests } from '@factory/testing';
import { fakeRouteAuth, mountApiRoutes } from '@factory/http/testing';

import { CredentialAccountRoutes } from './credential-accounts.ts';
import type { ClaudeSignInFlows, ClaudeSignInFlowView } from './credential-accounts.ts';

const apiKey = 'sk-ant-api03-aaaaaaaaaaaaaaaaaaaa1111';
const aliceToken = 'sk-ant-oat01-bbbbbbbbbbbbbbbbbbbb2222';
const now = new Date('2026-10-28T12:00:00Z');
const BASE = '/web/config/providers/anthropic/accounts';

async function setup(claudeSignIn?: ClaudeSignInFlows, accountSignIn?: Record<string, ClaudeSignInFlows>) {
  const seed = await createFactoryStorageForTests();
  const admins = new Set(['admin']);
  const app = (userId: string | null, orgId = 'org1') => {
    const hono = new Hono();
    hono.use('*', async (c, next) => {
      if (userId) c.set('factoryAuthUser' as never, { id: userId, organizationId: orgId } as never);
      await next();
    });
    mountApiRoutes(
      hono as never,
      new CredentialAccountRoutes({
        auth: fakeRouteAuth({ isOrganizationAdmin: async (_org, user) => admins.has(user) }),
        modelCredentials: seed.credentials,
        ...(claudeSignIn ? { claudeSignIn } : {}),
        ...(accountSignIn ? { accountSignIn } : {}),
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

/** A person's Claude sign-in, filed the way the sign-in flow files it. */
function addSignIn(seed: Awaited<ReturnType<typeof setup>>['seed'], ownerUserId: string, label = `${ownerUserId}@example.com`) {
  return seed.credentials.addAccount({
    orgId: 'org1',
    provider: 'anthropic',
    label,
    kind: 'claude_login',
    ownerUserId,
    secret: 'fake-access',
    oauth: { accessToken: 'fake-access', refreshToken: 'fake-refresh', expiresAt: 0, scopes: [] },
    createdBy: ownerUserId,
  });
}

describe('credential account routes', () => {
  it('refuses a pasted setup token or API key from anyone: Claude Code accounts are added by signing in', async () => {
    const { seed, send } = await setup();
    for (const [user, secret] of [
      ['alice', aliceToken],
      ['admin', apiKey],
    ] as const) {
      const refused = await send(user, 'POST', BASE, { label: 'Pasted', secret });
      expect(refused.status).toBe(410);
      expect(refused.body).toMatchObject({ error: 'claude_sign_in_required' });
    }
    expect(await seed.credentials.listAccounts('org1', 'anthropic')).toEqual([]);
    expect((await send('alice', 'POST', '/web/config/providers/openai/accounts', { label: 'x', secret: apiKey })).status).toBe(
      400,
    );
  });

  it('lists sign-ins without their tokens, and pasted ones left from before as legacy', async () => {
    const { seed, send } = await setup();
    await addSignIn(seed, 'alice');
    await seed.credentials.addAccount({
      orgId: 'org1',
      provider: 'anthropic',
      label: 'Old team key',
      kind: 'api_key',
      secret: apiKey,
      createdBy: 'admin',
    });

    const listed = await send('bob', 'GET', BASE);
    expect(listed.status).toBe(200);
    expect(listed.body).not.toHaveProperty('canAddOrgKeys');
    expect(listed.body.accounts).toEqual([
      expect.objectContaining({ label: 'alice@example.com', kind: 'claude_login', mine: false, canManage: false, legacy: false }),
      expect.objectContaining({ label: 'Old team key', kind: 'api_key', legacy: true }),
    ]);
    expect(listed.body.accounts[0]).not.toHaveProperty('canReplaceSecret');
    expect(JSON.stringify(listed.body)).not.toContain('fake-');
    expect(JSON.stringify(listed.body)).not.toContain(apiKey);
  });

  it('validates a change and takes no secret', async () => {
    const { seed, send } = await setup();
    const account = await addSignIn(seed, 'alice');
    const path = `${BASE}/${account.id}`;
    expect((await send('alice', 'PATCH', path, { label: '' })).status).toBe(400);
    expect((await send('alice', 'PATCH', path, { secret: aliceToken })).status).toBe(400);
    expect((await send('alice', 'PATCH', path, { owner: 'bob' })).status).toBe(400);
    expect((await send('alice', 'GET', BASE)).body.accounts[0]).toMatchObject({ label: 'alice@example.com', hint: '' });
  });

  it('needs a signed-in caller', async () => {
    const { send } = await setup();
    expect((await send(null, 'GET', BASE)).status).toBe(401);
  });

  it('lets the owner manage their sign-in, and an admin switch it off', async () => {
    const { seed, send } = await setup();
    const account = await addSignIn(seed, 'alice');
    const path = `${BASE}/${account.id}`;

    expect((await send('bob', 'PATCH', path, { label: 'mine now' })).status).toBe(403);
    expect((await send('alice', 'PATCH', path, { label: 'Work Max', priority: 3 })).body.account).toMatchObject({
      label: 'Work Max',
      priority: 3,
      mine: true,
    });
    expect((await send('admin', 'PATCH', path, { disabled: true })).body.account.status).toBe('disabled');
  });

  it('shows a limited account with its reset and clears it when switched back on', async () => {
    const { send, seed } = await setup();
    const account = await addSignIn(seed, 'alice');
    const until = new Date(now.getTime() + 3_600_000);
    await seed.credentials.markAccountLimited('org1', account.id, { until, error: '5-hour limit reached' });

    const listed = await send('alice', 'GET', BASE);
    expect(listed.body.accounts[0]).toMatchObject({
      status: 'limited',
      limitedUntil: until.toISOString(),
      lastError: '5-hour limit reached',
    });
    const enabled = await send('alice', 'PATCH', `${BASE}/${account.id}`, { disabled: false });
    expect(enabled.body.account.status).toBe('active');
    expect(enabled.body.account.limitedUntil).toBeUndefined();
  });

  it('removes an account for its owner or an admin, within the organization only, legacy ones too', async () => {
    const { seed, send } = await setup();
    const account = await addSignIn(seed, 'alice');
    const legacy = await seed.credentials.addAccount({
      orgId: 'org1',
      provider: 'anthropic',
      label: 'Old Max',
      kind: 'subscription',
      ownerUserId: 'alice',
      secret: aliceToken,
      createdBy: 'alice',
    });
    const path = `${BASE}/${account.id}`;

    expect((await send('bob', 'DELETE', path)).status).toBe(403);
    expect((await send('alice', 'DELETE', `${BASE}/00000000-0000-4000-8000-000000000000`)).status).toBe(404);
    expect((await send('alice', 'DELETE', path)).status).toBe(200);
    expect((await send('admin', 'DELETE', `${BASE}/${legacy.id}`)).status).toBe(200);
    expect((await send('alice', 'GET', BASE)).body.accounts).toEqual([]);
  });
});

describe('Claude sign-in routes', () => {
  /** Sign-in flows that finish when the test says so, filing the account the way the server does. */
  function flows(seed: () => Awaited<ReturnType<typeof setup>>['seed']) {
    const all = new Map<string, ClaudeSignInFlowView>();
    let next = 0;
    const signIn: ClaudeSignInFlows = {
      start: owner => {
        const flow: ClaudeSignInFlowView = { id: `flow-${++next}`, ...owner, status: 'pending' };
        all.set(flow.id, flow);
        return flow;
      },
      get: id => all.get(id),
      cancel: id => {
        const flow = all.get(id);
        if (!flow || flow.status !== 'pending') return false;
        all.set(id, { ...flow, status: 'error', error: 'Claude sign-in was cancelled.' });
        return true;
      },
    };
    const finish = async (id: string) => {
      const flow = all.get(id)!;
      const account = await seed().credentials.addAccount({
        orgId: flow.orgId,
        provider: 'anthropic',
        label: 'alice@example.com',
        kind: 'claude_login',
        ownerUserId: flow.userId,
        secret: 'fake-access',
        oauth: { accessToken: 'fake-access', refreshToken: 'fake-refresh', expiresAt: 0, scopes: [] },
        createdBy: flow.userId,
      });
      all.set(id, { ...flow, status: 'done', accountId: account.id });
      return account;
    };
    return { signIn, finish };
  }

  it('starts a person’s sign-in, reports it until done, and shows the account it filed without its tokens', async () => {
    let seedRef!: Awaited<ReturnType<typeof setup>>['seed'];
    const fake = flows(() => seedRef);
    const { seed, send } = await setup(fake.signIn);
    seedRef = seed;

    const started = await send('alice', 'POST', `${BASE}/sign-in`);
    expect(started.status).toBe(202);
    expect(started.body.signIn).toEqual({ id: 'flow-1', status: 'pending' });

    await fake.finish('flow-1');
    const done = await send('alice', 'GET', `${BASE}/sign-in/flow-1`);
    expect(done.body.signIn).toMatchObject({
      status: 'done',
      account: { kind: 'claude_login', mine: true, canManage: true, legacy: false, needsSignIn: false, hint: '' },
    });
    expect(JSON.stringify(done.body)).not.toContain('fake-');

    // Someone else's sign-in is not there for bob.
    expect((await send('bob', 'GET', `${BASE}/sign-in/flow-1`)).status).toBe(404);
    expect((await send('bob', 'DELETE', `${BASE}/sign-in/flow-1`)).status).toBe(404);
  });

  it('cancels a pending sign-in and refuses a signed-out caller', async () => {
    let seedRef!: Awaited<ReturnType<typeof setup>>['seed'];
    const fake = flows(() => seedRef);
    const { seed, send } = await setup(fake.signIn);
    seedRef = seed;

    await send('alice', 'POST', `${BASE}/sign-in`);
    expect((await send('alice', 'DELETE', `${BASE}/sign-in/flow-1`)).body).toEqual({ cancelled: true });
    expect((await send('alice', 'GET', `${BASE}/sign-in/flow-1`)).body.signIn).toMatchObject({
      status: 'error',
      error: 'Claude sign-in was cancelled.',
    });
    expect((await send(null, 'POST', `${BASE}/sign-in`)).status).toBeGreaterThanOrEqual(400);
  });

  it('says where sign-in works when this host does not offer it', async () => {
    const { send } = await setup();
    const refused = await send('alice', 'POST', `${BASE}/sign-in`);
    expect(refused.status).toBe(404);
    expect(refused.body).toMatchObject({ error: 'sign_in_unavailable' });
  });

  it('marks a refused sign-in as needing a new sign-in', async () => {
    const { seed, send } = await setup();
    const account = await seed.credentials.addAccount({
      orgId: 'org1',
      provider: 'anthropic',
      label: 'alice@example.com',
      kind: 'claude_login',
      ownerUserId: 'alice',
      secret: 'fake-access',
      oauth: { accessToken: 'fake-access', refreshToken: 'fake-refresh', expiresAt: 0, scopes: [] },
      createdBy: 'alice',
    });
    await seed.credentials.markAccountFailed('org1', account.id, 'sign in to Claude again');
    const listed = await send('alice', 'GET', BASE);
    expect(listed.body.accounts[0]).toMatchObject({ status: 'disabled', needsSignIn: true, lastError: 'sign in to Claude again' });
    // A sign-in has no secret to paste over: it is renewed by signing in again.
    expect((await send('alice', 'PATCH', `${BASE}/${account.id}`, { secret: 'sk-ant-oat01-cccccccccccccccccccc3333' })).status).toBe(400);
  });
});

describe('Codex accounts', () => {
  const CODEX = '/web/config/providers/openai-codex/accounts';

  it('lists ChatGPT sign-ins as Codex accounts, a Claude sign-in never among them, and refuses a pasted key', async () => {
    const { seed, send } = await setup();
    await addSignIn(seed, 'alice');
    await seed.credentials.addAccount({
      orgId: 'org1',
      provider: 'openai-codex',
      label: 'alice@example.com',
      kind: 'codex_login',
      ownerUserId: 'alice',
      secret: 'fake-access',
      oauth: { accessToken: 'fake-access', refreshToken: 'fake-refresh', expiresAt: 0, scopes: [], workspaceId: 'ws-1' },
      createdBy: 'alice',
    });
    const listed = await send('alice', 'GET', CODEX);
    expect(listed.body.accounts).toEqual([
      expect.objectContaining({ kind: 'codex_login', mine: true, canManage: true, legacy: false, needsSignIn: false, hint: '' }),
    ]);
    expect(JSON.stringify(listed.body)).not.toContain('fake-');
    const refused = await send('alice', 'POST', CODEX, { label: 'Pasted', secret: 'sk-proj-x' });
    expect(refused.status).toBe(410);
    expect(refused.body).toMatchObject({ error: 'sign_in_required', message: expect.stringContaining('signing in to ChatGPT') });
  });

  it('runs a Codex sign-in where the server offers one, and refuses where it offers none', async () => {
    const flow: ClaudeSignInFlowView = { id: 'flow-1', orgId: 'org1', userId: 'alice', status: 'pending' };
    const signIn: ClaudeSignInFlows = { start: () => flow, get: id => (id === flow.id ? flow : undefined), cancel: () => true };
    const { send } = await setup(undefined, { 'openai-codex': signIn });
    const started = await send('alice', 'POST', `${CODEX}/sign-in`);
    expect(started.status).toBe(202);
    expect(started.body.signIn).toEqual({ id: 'flow-1', status: 'pending' });
    // The Claude sign-in stays Claude's: none is offered here.
    expect((await send('alice', 'POST', `${BASE}/sign-in`)).status).toBe(404);
    const { send: without } = await setup();
    expect((await without('alice', 'POST', `${CODEX}/sign-in`)).body).toMatchObject({
      error: 'sign_in_unavailable',
      message: 'Signing in to ChatGPT here works only where the Factory server runs on your own machine.',
    });
  });
});
