import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import type { AccountUsageLimits, HarnessUsage } from '@factory/harness/usage';
import { createHarnessUsageRegistry } from '@factory/harness/usage';
import { fakeRouteAuth, mountApiRoutes } from '@factory/http/testing';
import type { Card, RecordUsageTurnInput, SourceControlSession } from '@factory/store';
import { createFactoryStorageForTests } from '@factory/testing';

import { parseUsagePeriod, UsageRoutes } from './usage.ts';

const now = new Date('2026-11-11T12:00:00.000Z');

type SessionRow = Pick<SourceControlSession, 'sessionId' | 'orgId' | 'userId' | 'visibility'> & { title?: string | null };

async function setup(
  readAccountLimits?: HarnessUsage['readAccountLimits'],
  options: { sessions?: SessionRow[]; cards?: Array<{ orgId: string; id: string }>; isAdmin?: (userId: string) => boolean } = {},
) {
  const seed = await createFactoryStorageForTests();
  // Every turn the tests record runs in alice's shared session unless a test says otherwise.
  const rows = new Map<string, SessionRow>(
    (options.sessions ?? [
      { sessionId: 'session-1', orgId: 'org1', userId: 'alice', visibility: 'org', title: 'Fix login flow' },
      { sessionId: 'session-2', orgId: 'org1', userId: 'alice', visibility: 'org' },
    ]).map(row => [row.sessionId, row]),
  );
  const cards = options.cards ?? [
    { orgId: 'org1', id: 'card-1' },
    { orgId: 'org1', id: 'card-2' },
  ];
  const sessions = { getBySessionId: async (id: string) => (rows.get(id) as SourceControlSession | undefined) ?? null };
  const workItems = {
    get: async ({ orgId, id }: { orgId: string; id: string }) =>
      cards.some(card => card.orgId === orgId && card.id === id) ? ({ id } as Card) : null,
  };
  const harnesses = createHarnessUsageRegistry([
    { harnessId: 'claude-code', displayName: 'Claude Code', accountProvider: 'anthropic', ...(readAccountLimits ? { readAccountLimits } : {}) },
  ]);
  const app = (userId: string | null, orgId: string | undefined = 'org1') => {
    const hono = new Hono();
    hono.use('*', async (c, next) => {
      if (userId) c.set('factoryAuthUser' as never, { id: userId, organizationId: orgId } as never);
      await next();
    });
    mountApiRoutes(
      hono as never,
      new UsageRoutes({
        auth: fakeRouteAuth({ isOrganizationAdmin: async (_org, user) => options.isAdmin?.(user) ?? false }),
        usage: seed.usage,
        harnesses,
        sessions,
        workItems,
        modelCredentials: seed.credentials,
        projects: seed.projects,
        now: () => now,
      }).routes(),
    );
    return hono;
  };
  const get = async (path: string, userId: string | null = 'alice') => {
    const response = await app(userId).request(path);
    return { status: response.status, body: (await response.json()) as any };
  };
  const addSignIn = (label: string) =>
    seed.credentials.addAccount({
      orgId: 'org1',
      provider: 'anthropic',
      label,
      kind: 'claude_login',
      ownerUserId: 'alice',
      secret: 'access',
      oauth: { accessToken: 'access', refreshToken: 'refresh', expiresAt: 0, scopes: [] },
      createdBy: 'alice',
    });
  return { seed, get, addSignIn };
}

const turn = (overrides: Partial<RecordUsageTurnInput> = {}): RecordUsageTurnInput => ({
  orgId: 'org1',
  sessionId: 'session-1',
  threadId: 'thread-1',
  runId: null,
  factoryProjectId: 'factory-1',
  workItemId: null,
  kickoffId: null,
  role: null,
  userId: 'alice',
  harnessId: 'claude-code',
  model: 'claude-sonnet-4-6',
  accountId: null,
  occurredAt: '2026-11-10T09:00:00.000Z',
  totals: { inputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 100_000, reasoningTokens: 0 },
  stepCount: 1,
  contextTokens: 50_000,
  reportedCostUsd: null,
  ...overrides,
});

describe('parseUsagePeriod', () => {
  it('defaults to the last 30 days, never ends after today and never spans more than a year', () => {
    expect(parseUsagePeriod(undefined, undefined, now)).toEqual({ from: '2026-10-13', to: '2026-11-11' });
    expect(parseUsagePeriod('2026-11-01', '2027-01-01', now)).toEqual({ from: '2026-11-01', to: '2026-11-11' });
    expect(parseUsagePeriod('2020-01-01', '2026-11-11', now).from).toBe('2025-11-11');
    expect(parseUsagePeriod('2026-11-20', '2026-11-05', now)).toEqual({ from: '2026-11-05', to: '2026-11-05' });
    expect(parseUsagePeriod('nonsense', 'x', now).to).toBe('2026-11-11');
  });
});

/** `/web/usage/limits` keyed by account, as the per-account reads below compare it. */
const limitsOf = (response: { status: number; body: any }) => ({
  status: response.status,
  body: { accounts: Object.fromEntries((response.body.accounts ?? []).map((entry: { accountId: string; usage: unknown }) => [entry.accountId, entry.usage])) },
});

describe('usage routes', () => {
  it('asks the provider for each sign-in’s windows on refresh, at most once a minute, and keeps the last answer when a probe fails', async () => {
    let answer: AccountUsageLimits = {
      checkedAt: now.toISOString(),
      source: 'probe',
      windows: [{ id: 'five_hour', kind: 'session', usedPercent: 42, resetsAt: '2026-11-11T15:00:00.000Z' }],
    };
    const read = vi.fn(async () => answer);
    const { seed, get, addSignIn } = await setup(read);
    const account = await addSignIn('alice@example.com');

    const first = await limitsOf(await get('/web/usage/limits?refresh=1'));
    expect(first.status).toBe(200);
    expect(first.body.accounts[account.id]).toMatchObject({ source: 'probe', windows: [{ id: 'five_hour', usedPercent: 42 }] });
    expect(read).toHaveBeenCalledTimes(1);

    // Within a minute: the stored answer, marked as not asked again.
    const again = await limitsOf(await get('/web/usage/limits?refresh=1'));
    expect(again.body.accounts[account.id]).toMatchObject({ stale: true, windows: [{ usedPercent: 42 }] });
    expect(read).toHaveBeenCalledTimes(1);
    // Without refresh, nothing is asked.
    expect(limitsOf(await get('/web/usage/limits')).body.accounts[account.id].stale).toBeUndefined();

    await seed.usage.saveAccountLimits('org1', account.id, { ...answer, checkedAt: '2026-11-11T11:00:00.000Z' });
    answer = { checkedAt: now.toISOString(), source: 'probe', windows: [], unavailable: { reason: 'failed', message: 'HTTP 500' } };
    const failed = await limitsOf(await get('/web/usage/limits?refresh=1'));
    expect(failed.body.accounts[account.id]).toMatchObject({
      stale: true,
      windows: [{ usedPercent: 42 }],
      unavailable: { reason: 'failed', message: 'HTTP 500' },
    });
    expect((await get('/web/usage/limits', null)).status).toBe(401);
  });

  it('lists every harness’s sign-ins with their windows in one place, and puts right a reading in the wrong unit', async () => {
    let answer: AccountUsageLimits = {
      checkedAt: '2026-11-11T11:00:00.000Z',
      source: 'probe',
      windows: [
        { id: 'five_hour', kind: 'session', usedPercent: 54, resetsAt: '2026-11-11T15:00:00.000Z' },
        { id: 'seven_day_opus', kind: 'model', label: 'Opus', usedPercent: 12 },
        { id: 'monthly_spend', kind: 'spend', usedPercent: 9 },
      ],
    };
    const read = vi.fn(async () => answer);
    const { seed, get, addSignIn } = await setup(read);
    const alice = await addSignIn('alice@example.com');
    const unread = await addSignIn('bob@example.com');
    await seed.usage.saveAccountLimits('org1', alice.id, answer);
    await seed.usage.saveAccountLimits('org2', unread.id, answer);

    // Without refresh: what is stored, with whose it is; an account never read is left out.
    const stored = await get('/web/usage/limits');
    expect(stored.status).toBe(200);
    expect(read).not.toHaveBeenCalled();
    expect(stored.body.accounts).toEqual([
      {
        accountId: alice.id,
        label: 'alice@example.com',
        harnessId: 'claude-code',
        harnessName: 'Claude Code',
        provider: 'anthropic',
        disabled: false,
        usage: expect.objectContaining({ windows: answer.windows }),
      },
    ]);

    // The provider answers 0.55 for the 5-hour window it said 54 of in the same period: a fraction.
    answer = {
      checkedAt: now.toISOString(),
      source: 'probe',
      windows: [{ id: 'five_hour', kind: 'session', usedPercent: 0.55, resetsAt: '2026-11-11T15:00:00.000Z' }],
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const refreshed = await get('/web/usage/limits?refresh=1');
    expect(read).toHaveBeenCalledTimes(2);
    const aliceView = refreshed.body.accounts.find((entry: { accountId: string }) => entry.accountId === alice.id);
    expect(aliceView.usage.windows).toEqual([{ id: 'five_hour', kind: 'session', usedPercent: 55, resetsAt: '2026-11-11T15:00:00.000Z' }]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('five_hour'));
    warn.mockRestore();
    expect((await get('/web/usage/limits', null)).status).toBe(401);
  });

  it('sums a period by day, harness, model, account and Factory, with names for accounts and Factories', async () => {
    const { seed, get, addSignIn } = await setup();
    const account = await addSignIn('alice@example.com');
    const project = await seed.projects.create({ orgId: 'org1', userId: 'alice', input: { name: 'Payments' } });
    const factoryProjectId = project.id;
    await seed.usage.recordTurn(turn({ accountId: account.id, factoryProjectId, kickoffId: 'kick-1', role: 'implementer' }));
    await seed.usage.recordTurn(turn({ harnessId: 'codex', model: 'gpt-5.1-codex', occurredAt: '2026-11-11T08:00:00.000Z', factoryProjectId }));
    await seed.usage.recordTurn(turn({ occurredAt: '2026-09-01T08:00:00.000Z' }));
    await seed.usage.recordTurn(turn({ orgId: 'org2' }));

    const { status, body } = await get('/web/usage/summary?from=2026-11-09&to=2026-11-11');
    expect(status).toBe(200);
    expect(body.byDay.map((day: { day: string; turns: number }) => [day.day, day.turns])).toEqual([
      ['2026-11-09', 0],
      ['2026-11-10', 1],
      ['2026-11-11', 1],
    ]);
    expect(body.total.turns).toBe(2);
    expect(body.total.costUsd).toBeCloseTo(3 + 1.5 + 1.25 + 1);
    expect(body.byHarness.map((group: { key: string }) => group.key)).toEqual(['claude-code', 'codex']);
    expect(body.labels.accounts[account.id]).toBe('alice@example.com');
    expect(body.labels.factories[project.id]).toBe('Payments');
    expect(body.byFactory[0].key).toBe(project.id);
    expect(body.byRole.map((group: { key: string; turns: number }) => [group.key, group.turns])).toEqual([
      ['implementer', 1],
      ['', 1],
    ]);
    expect(body.bySession.map((group: { key: string }) => group.key)).toEqual(['session-1']);
    expect(body.labels.sessions).toEqual({ 'session-1': 'Fix login flow' });

    const filtered = await get('/web/usage/summary?from=2026-11-09&to=2026-11-11&harnessId=codex');
    expect(filtered.body.total.turns).toBe(1);
  });

  it('serves a session’s turns and context fill, and each card’s runs', async () => {
    const { seed, get } = await setup();
    await seed.usage.recordTurn(turn({ workItemId: 'card-1', kickoffId: 'kick-1' }));
    await seed.usage.recordTurn(turn({ workItemId: 'card-1', kickoffId: 'kick-2', occurredAt: '2026-11-10T10:00:00.000Z', contextTokens: 80_000 }));
    await seed.usage.recordTurn(turn({ sessionId: 'session-2', workItemId: 'card-2' }));

    const session = await get('/web/usage/sessions/session-1');
    expect(session.body.usage.turns).toHaveLength(2);
    expect(session.body.usage.context).toEqual({ tokens: 80_000, window: 1_000_000 });
    expect((await get('/web/usage/sessions/session-1', 'bob')).body.usage.turns).toHaveLength(2);

    const cards = await get('/web/usage/work-items?ids=card-1,card-2,card-3');
    expect(Object.keys(cards.body.workItems).sort()).toEqual(['card-1', 'card-2']);
    expect(cards.body.workItems['card-1'].runs.map((run: { kickoffId: string }) => run.kickoffId)).toEqual(['kick-2', 'kick-1']);
    expect((await get(`/web/usage/work-items?ids=${Array.from({ length: 201 }, (_, i) => `c${i}`).join(',')}`)).status).toBe(400);
  });
});

describe('usage routes keep a session’s usage to whoever may read the session', () => {
  const sessions: SessionRow[] = [
    { sessionId: 'alice-private', orgId: 'org1', userId: 'alice', visibility: 'private' },
    { sessionId: 'alice-shared', orgId: 'org1', userId: 'alice', visibility: 'org' },
    { sessionId: 'bob-private', orgId: 'org1', userId: 'bob', visibility: 'private' },
  ];
  const cards = [{ orgId: 'org1', id: 'card-1' }];
  // carol administers org1; private sessions stay their owner's for admins too, as the session routes keep them.
  const isAdmin = (userId: string) => userId === 'carol';

  async function seeded() {
    const ctx = await setup(undefined, { sessions, cards, isAdmin });
    await ctx.seed.usage.recordTurn(turn({ sessionId: 'alice-private', userId: 'alice', workItemId: 'card-1', kickoffId: 'k-private' }));
    await ctx.seed.usage.recordTurn(turn({ sessionId: 'alice-shared', userId: 'alice', workItemId: 'card-1', kickoffId: 'k-shared' }));
    await ctx.seed.usage.recordTurn(turn({ sessionId: 'bob-private', userId: 'bob' }));
    // A turn whose session row is gone: only the person it was recorded for sees it.
    await ctx.seed.usage.recordTurn(turn({ sessionId: 'deleted', userId: 'bob' }));
    return ctx;
  }

  it('the owner reads their private session’s usage and every turn of their own', async () => {
    const { get } = await seeded();
    const session = await get('/web/usage/sessions/alice-private', 'alice');
    expect(session.status).toBe(200);
    expect(session.body.usage.turns).toHaveLength(1);
    const summary = await get('/web/usage/summary?from=2026-11-09&to=2026-11-11', 'alice');
    expect(summary.body.total.turns).toBe(2);
    const card = await get('/web/usage/work-items?ids=card-1', 'alice');
    expect(card.body.workItems['card-1'].runs.map((run: { kickoffId: string }) => run.kickoffId).sort()).toEqual(['k-private', 'k-shared']);
  });

  it('a member gets 404 for a teammate’s private session and never counts its turns', async () => {
    const { get } = await seeded();
    expect((await get('/web/usage/sessions/alice-private', 'bob')).status).toBe(404);
    const summary = await get('/web/usage/summary?from=2026-11-09&to=2026-11-11', 'bob');
    // alice's shared session, bob's own private one and bob's turn whose session is gone.
    expect(summary.body.total.turns).toBe(3);
    const card = await get('/web/usage/work-items?ids=card-1', 'bob');
    expect(card.body.workItems['card-1'].runs.map((run: { kickoffId: string }) => run.kickoffId)).toEqual(['k-shared']);
    expect(card.body.workItems['card-1'].total.turns).toBe(1);
  });

  it('a member reads a teammate’s shared session', async () => {
    const { get } = await seeded();
    const session = await get('/web/usage/sessions/alice-shared', 'bob');
    expect(session.status).toBe(200);
    expect(session.body.usage.turns).toHaveLength(1);
  });

  it('an admin reads shared sessions but not a teammate’s private one, as the session routes allow', async () => {
    const { get } = await seeded();
    expect((await get('/web/usage/sessions/alice-shared', 'carol')).status).toBe(200);
    expect((await get('/web/usage/sessions/alice-private', 'carol')).status).toBe(404);
    expect((await get('/web/usage/sessions/bob-private', 'carol')).status).toBe(404);
    const summary = await get('/web/usage/summary?from=2026-11-09&to=2026-11-11', 'carol');
    expect(summary.body.total.turns).toBe(1);
    const card = await get('/web/usage/work-items?ids=card-1', 'carol');
    expect(card.body.workItems['card-1'].total.turns).toBe(1);
  });

  it('answers nothing for a card the organization cannot read', async () => {
    const { seed, get } = await seeded();
    await seed.usage.recordTurn(turn({ sessionId: 'alice-shared', workItemId: 'card-elsewhere' }));
    const cardsBody = (await get('/web/usage/work-items?ids=card-1,card-elsewhere', 'alice')).body;
    expect(Object.keys(cardsBody.workItems)).toEqual(['card-1']);
  });
});
