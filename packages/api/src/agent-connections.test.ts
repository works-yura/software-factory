import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import { CLAUDE_CODE_HARNESS, CODEX_HARNESS } from '@factory/contracts';
import type { HarnessDescriptor } from '@factory/contracts';
import type { HarnessUsage } from '@factory/harness/usage';
import { fakeRouteAuth, mountApiRoutes } from '@factory/http/testing';
import { buildConnectionRoutes } from '@factory/integrations';
import type { SignInCredentialKind } from '@factory/store';
import { createFactoryStorageForTests } from '@factory/testing';

import { describeConnectorContract } from '@factory/integrations/testing';

import { createAgentAccountsConnections } from './agent-connections.ts';
import type { AccountSignInFlows, AccountSignInFlowView } from './credential-accounts.ts';

const now = new Date('2026-11-12T12:00:00.000Z');

/**
 * A harness CLI's sign-in as the server runs it, without the CLI: `start` files nothing until the
 * test says the browser step finished (`finish`), then files the account as the real service does.
 */
function fakeCliSignIn(file: (owner: { orgId: string; userId: string }) => Promise<string>) {
  const flows = new Map<string, AccountSignInFlowView>();
  let next = 0;
  const service: AccountSignInFlows = {
    start: owner => {
      const flow: AccountSignInFlowView = { id: `flow-${++next}`, ...owner, status: 'pending' };
      flows.set(flow.id, flow);
      return { ...flow };
    },
    get: id => (flows.has(id) ? { ...flows.get(id)! } : undefined),
    cancel: () => false,
  };
  return {
    service,
    async finish(id: string, outcome: 'done' | { error: string } = 'done') {
      const flow = flows.get(id)!;
      if (outcome === 'done') Object.assign(flow, { status: 'done', accountId: await file(flow) });
      else Object.assign(flow, { status: 'error', error: outcome.error });
    },
  };
}

interface HarnessCase {
  harness: HarnessDescriptor;
  kind: SignInCredentialKind;
  signInName: string;
}

const CASES: HarnessCase[] = [
  { harness: CLAUDE_CODE_HARNESS, kind: 'claude_login', signInName: 'Claude' },
  { harness: CODEX_HARNESS, kind: 'codex_login', signInName: 'ChatGPT' },
];

async function setup({ harness, kind, signInName }: HarnessCase, options: { signIn?: boolean; readAccountLimits?: HarnessUsage['readAccountLimits'] } = {}) {
  const seed = await createFactoryStorageForTests();
  const provider = harness.setup.accounts!.provider;
  const connector = harness.setup.accounts!.connector;
  const addSignIn = (ownerUserId: string, extra: { label?: string; plan?: string } = {}) =>
    seed.credentials.addAccount({
      orgId: 'org1',
      provider,
      label: extra.label ?? `${ownerUserId}@example.com`,
      kind,
      ownerUserId,
      secret: 'access',
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        expiresAt: 0,
        scopes: [],
        email: `${ownerUserId}@example.com`,
        ...(extra.plan ? { subscriptionType: extra.plan } : {}),
      },
      createdBy: ownerUserId,
    });
  const cli = fakeCliSignIn(async owner => (await addSignIn(owner.userId)).id);
  const facet: HarnessUsage = {
    harnessId: harness.id,
    displayName: harness.label,
    accountProvider: provider,
    ...(options.readAccountLimits ? { readAccountLimits: options.readAccountLimits } : {}),
  };
  const connections = createAgentAccountsConnections({
    harness,
    kind,
    signInName,
    credentials: seed.credentials,
    ...(options.signIn === false ? {} : { signIn: cli.service }),
    usage: { storage: seed.usage, facet },
    projects: seed.projects,
    userName: async userId => ({ alice: 'Alice', bob: 'Bob' })[userId],
    now: () => now,
  });
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
  return { seed, cli, send, addSignIn, connector, provider, connections };
}

/** The same connector `setup` builds, over a seeded storage, for the conformance kit. */
function connectionsOf(seed: Awaited<ReturnType<typeof createFactoryStorageForTests>>, signIn: AccountSignInFlows, { harness, kind, signInName }: HarnessCase) {
  return createAgentAccountsConnections({ harness, kind, signInName, credentials: seed.credentials, signIn, usage: { storage: seed.usage }, projects: seed.projects, now: () => now });
}

describe.each(CASES)('$harness.label accounts as a connector', harnessCase => {
  const { harness, signInName } = harnessCase;

  it('describes itself under «Агенти» with its CLI sign-in, in the request language', async () => {
    const { send, connector } = await setup(harnessCase);
    const { body } = await send('alice', 'GET', '/web/connections/methods');
    const described = body.connectors.find((entry: { id: string }) => entry.id === connector);
    expect(described).toMatchObject({
      id: connector,
      name: harness.label,
      icon: harness.icon,
      category: 'agents',
      provides: [{ key: 'agent' }],
      methods: [{ id: 'sign-in', authKind: 'oauth', available: true, label: `Sign in with ${signInName}` }],
    });
    const uk = await send('alice', 'GET', '/web/connections/methods', undefined, 'uk');
    expect(uk.body.connectors[0].methods[0].label).toBe(`Увійти через ${signInName}`);
  });

  it('offers the sign-in disabled with a reason where the server cannot run it', async () => {
    const { send } = await setup(harnessCase, { signIn: false });
    const { body } = await send('alice', 'GET', '/web/connections/methods');
    expect(body.connectors[0].methods[0].available).toEqual({ reason: expect.stringContaining('your own machine') });
    const refused = await send('alice', 'POST', '/web/connections', { connector: harness.setup.accounts!.connector, method: 'sign-in' });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('sign_in_unavailable');
  });

  it('lets a member sign in: authorize with a waiting note, then the flow is followed to its account', async () => {
    const { send, cli, connector, seed, provider } = await setup(harnessCase);
    const started = await send('bob', 'POST', '/web/connections', { connector, method: 'sign-in', input: {} });
    expect(started.status).toBe(200);
    expect(started.body).toMatchObject({ type: 'authorize', authId: 'flow-1', waiting: { timeoutMs: 300_000 } });
    expect(started.body.url).toBeUndefined();

    const status = (userId: string) => send(userId, 'GET', `/web/connections/authorizations/flow-1?connector=${connector}`);
    expect((await status('bob')).body).toEqual({ status: 'pending' });
    // Another person's sign-in is not there for them.
    expect((await status('alice')).status).toBe(404);

    await cli.finish('flow-1');
    expect((await status('bob')).body).toEqual({ status: 'completed' });
    expect((await seed.credentials.listAccounts('org1', provider)).map(account => account.ownerUserId)).toEqual(['bob']);
  });

  it('says why a sign-in failed', async () => {
    const { send, cli, connector } = await setup(harnessCase);
    await send('bob', 'POST', '/web/connections', { connector, method: 'sign-in', input: {} });
    await cli.finish('flow-1', { error: `${signInName} sign-in was cancelled.` });
    const { body } = await send('bob', 'GET', `/web/connections/authorizations/flow-1?connector=${connector}`);
    expect(body).toEqual({ status: 'failed', message: `${signInName} sign-in was cancelled.` });
  });

  it('lists one connection per account: connected, limited with its reset, needing sign-in, off, and old tokens', async () => {
    const { send, seed, addSignIn, connector, provider } = await setup(harnessCase);
    const ok = await addSignIn('alice', { plan: 'max' });
    const limited = await addSignIn('bob');
    await seed.credentials.markAccountLimited('org1', limited.id, { until: new Date('2026-11-12T17:00:00.000Z'), error: 'out of usage' });
    const refused = await addSignIn('carol');
    await seed.credentials.markAccountFailed('org1', refused.id, 'invalid_grant');
    const off = await addSignIn('dave');
    await seed.credentials.updateAccount('org1', off.id, { disabled: true });
    const legacy = await seed.credentials.addAccount({ orgId: 'org1', provider, label: 'Old key', kind: 'api_key', secret: 'sk-old-1234567890', createdBy: 'admin' });

    const { body } = await send('alice', 'GET', '/web/connections');
    const byId = new Map(body.connections.map((connection: { id: string }) => [connection.id, connection]));
    expect(byId.get(`${connector}:${ok.id}`)).toMatchObject({
      status: 'active',
      accountLabel: 'alice@example.com',
      accountDetail: 'Yours · max',
      state: { tone: 'ok' },
      provides: [{ key: 'agent' }],
      actions: { rename: true, remove: true, reconnect: { method: { id: 'sign-in' } } },
    });
    expect(byId.get(`${connector}:${limited.id}`)).toMatchObject({
      status: 'active',
      accountDetail: 'Bob',
      state: { tone: 'warning', label: expect.stringContaining('Out of usage until') },
      // A member may not change another member's account, nor sign in to it.
      actions: { rename: { reason: expect.any(String) }, remove: { reason: expect.any(String) }, reconnect: { reason: expect.any(String) } },
    });
    expect(byId.get(`${connector}:${refused.id}`)).toMatchObject({ status: 'needs_reauth', state: { tone: 'error', message: expect.stringContaining('invalid_grant') } });
    expect(byId.get(`${connector}:${off.id}`)).toMatchObject({ status: 'active', state: { tone: 'idle', label: 'Off' } });
    expect(byId.get(`${connector}:${legacy.id}`)).toMatchObject({ accountLabel: null, state: { label: 'Old token' }, actions: { reconnect: { reason: expect.any(String) } } });
  });

  it('lets the owner or an admin rename, turn off and remove an account; not another member', async () => {
    const { send, seed, addSignIn, connector } = await setup(harnessCase);
    const account = await addSignIn('alice');
    await addSignIn('alice', { label: 'second' });
    const id = `${connector}:${account.id}`;

    expect((await send('bob', 'PATCH', `/web/connections/${id}`, { name: 'Mine now' })).status).toBe(403);
    expect((await send('alice', 'PATCH', `/web/connections/${id}`, { name: 'Work' })).body).toEqual({ name: 'Work' });
    expect((await seed.credentials.getAccount('org1', account.id))?.label).toBe('Work');

    const toggled = await send('admin', 'PATCH', `/web/connections/${id}/settings`, { section: 'rotation', values: { enabled: false } });
    expect(toggled.status).toBe(200);
    expect((await seed.credentials.getAccount('org1', account.id))?.disabled).toBe(true);

    expect((await send('bob', 'DELETE', `/web/connections/${id}`)).status).toBe(403);
    const removed = await send('alice', 'DELETE', `/web/connections/${id}`);
    expect(removed.body).toMatchObject({ removed: true });
    expect(await seed.credentials.getAccount('org1', account.id)).toBeUndefined();
  });

  it('only lets the owner sign in to an account again', async () => {
    const { send, addSignIn, connector } = await setup(harnessCase);
    const account = await addSignIn('alice');
    expect((await send('admin', 'POST', `/web/connections/${connector}:${account.id}/reconnect`, { input: {} })).status).toBe(403);
    const again = await send('alice', 'POST', `/web/connections/${connector}:${account.id}/reconnect`, { input: {} });
    expect(again.body).toMatchObject({ type: 'authorize', authId: expect.any(String) });
  });

  it("names the Factories whose sessions stop when the owner's last account goes, and asks to confirm", async () => {
    const { send, seed, addSignIn, connector } = await setup(harnessCase);
    const account = await addSignIn('alice');
    await seed.projects.create({ orgId: 'org1', userId: 'alice', input: { name: 'Shop', harness: harness.id as never } });
    await seed.projects.create({ orgId: 'org1', userId: 'alice', input: { name: 'Docs' } });
    const id = `${connector}:${account.id}`;

    const impact = await send('alice', 'GET', `/web/connections/${id}/impact`);
    expect(impact.body).toMatchObject({
      requiresConfirm: true,
      dependents: [{ label: 'Shop' }],
      items: [{ label: 'Shop', outcome: 'stops' }],
      warning: expect.stringContaining(harness.label),
    });
    const refused = await send('alice', 'DELETE', `/web/connections/${id}`);
    expect(refused.status).toBe(409);
    expect(refused.body.impact.items).toHaveLength(1);
    expect((await send('alice', 'DELETE', `/web/connections/${id}?confirm=1`)).status).toBe(200);
  });

  it('says rotation goes on when the owner keeps another account', async () => {
    const { send, addSignIn, connector } = await setup(harnessCase);
    const account = await addSignIn('alice');
    await addSignIn('alice', { label: 'spare' });
    const { body } = await send('alice', 'GET', `/web/connections/${connector}:${account.id}/impact`);
    expect(body).toMatchObject({ requiresConfirm: false, items: [], body: expect.stringContaining('other') });
  });

  it('details the account: facts, its limits with reset times, rotation, and recent usage for its owner', async () => {
    const readAccountLimits = vi.fn<NonNullable<HarnessUsage['readAccountLimits']>>(async () => ({
      checkedAt: now.toISOString(),
      source: 'probe',
      windows: [
        { id: 'five_hour', kind: 'session', usedPercent: 42, resetsAt: '2026-11-12T15:00:00.000Z' },
        { id: 'seven_day', kind: 'weekly', usedPercent: 81.4, resetsAt: '2026-11-15T00:00:00.000Z' },
      ],
    }));
    const { send, seed, addSignIn, connector } = await setup(harnessCase, { readAccountLimits });
    const account = await addSignIn('alice');
    await seed.usage.recordTurn({
      orgId: 'org1',
      sessionId: 's1',
      threadId: null,
      runId: null,
      factoryProjectId: null,
      workItemId: null,
      kickoffId: null,
      role: null,
      userId: 'alice',
      harnessId: harness.id,
      model: null,
      accountId: account.id,
      occurredAt: '2026-11-11T09:00:00.000Z',
      totals: { inputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 200, reasoningTokens: 0 },
      stepCount: 1,
      contextTokens: null,
      reportedCostUsd: null,
    });

    const { body } = await send('alice', 'GET', `/web/connections/${connector}:${account.id}/detail`);
    const types = body.sections.map((section: { type: string }) => section.type);
    expect(types).toEqual(['facts', 'table', 'settings', 'table']);
    expect(body.sections[1]).toMatchObject({ title: 'Usage limits', rows: [{ cells: ['5-hour', '42%', expect.any(String)] }, { cells: ['Weekly', '81%', expect.any(String)] }] });
    expect(body.sections[2]).toMatchObject({ id: 'rotation', fields: [{ name: 'enabled', type: 'boolean', value: true }] });
    expect(body.sections[3]).toMatchObject({ rows: [{ cells: ['2026-11-11', '1', '1,200'] }] });
    expect(readAccountLimits).toHaveBeenCalledWith({ orgId: 'org1', accountId: account.id });

    // Another member sees the account, not the work that ran on it; the switch is theirs to read only.
    const other = await send('bob', 'GET', `/web/connections/${connector}:${account.id}/detail`);
    expect(other.body.sections.map((section: { type: string }) => section.type)).toEqual(['facts', 'table', 'settings']);
    expect(other.body.sections[2].fields[0].disabled).toEqual({ reason: expect.any(String) });
  });
});

// The connector conformance kit (`@factory/integrations/testing`) for each harness's accounts.
for (const harnessCase of CASES) {
  describeConnectorContract(`${harnessCase.harness.label} accounts`, async () => {
    const { seed, cli, addSignIn } = await setup(harnessCase);
    await addSignIn('admin', { plan: 'max' });
    const limited = await addSignIn('member');
    await seed.credentials.markAccountLimited('org1', limited.id, { until: new Date('2026-11-12T17:00:00.000Z'), error: 'out of usage' });
    return {
      registration: { id: harnessCase.harness.setup.accounts!.connector, connections: connectionsOf(seed, cli.service, harnessCase) },
      orgId: 'org1',
      admin: 'admin',
      member: 'member',
      secrets: ['access', 'refresh'].map(token => `"${token}"`),
      expectsConnections: true,
      authorize: { as: 'member', method: 'sign-in', finish: authId => cli.finish(authId) },
      rename: true,
      remove: true,
    };
  });
}
