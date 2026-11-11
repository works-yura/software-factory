import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import type { AccountUsageLimits, HarnessUsage } from '@factory/harness/usage';
import { createHarnessUsageRegistry } from '@factory/harness/usage';
import { fakeRouteAuth, mountApiRoutes } from '@factory/http/testing';
import type { RecordUsageTurnInput } from '@factory/store';
import { createFactoryStorageForTests } from '@factory/testing';

import { parseUsagePeriod, UsageRoutes } from './usage.ts';

const now = new Date('2026-11-11T12:00:00.000Z');

async function setup(readAccountLimits?: HarnessUsage['readAccountLimits']) {
  const seed = await createFactoryStorageForTests();
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
        auth: fakeRouteAuth(),
        usage: seed.usage,
        harnesses,
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

    const first = await get('/web/config/providers/anthropic/accounts/usage?refresh=1');
    expect(first.status).toBe(200);
    expect(first.body.accounts[account.id]).toMatchObject({ source: 'probe', windows: [{ id: 'five_hour', usedPercent: 42 }] });
    expect(read).toHaveBeenCalledTimes(1);

    // Within a minute: the stored answer, marked as not asked again.
    const again = await get('/web/config/providers/anthropic/accounts/usage?refresh=1');
    expect(again.body.accounts[account.id]).toMatchObject({ stale: true, windows: [{ usedPercent: 42 }] });
    expect(read).toHaveBeenCalledTimes(1);
    // Without refresh, nothing is asked.
    expect((await get('/web/config/providers/anthropic/accounts/usage')).body.accounts[account.id].stale).toBeUndefined();

    await seed.usage.saveAccountLimits('org1', account.id, { ...answer, checkedAt: '2026-11-11T11:00:00.000Z' });
    answer = { checkedAt: now.toISOString(), source: 'probe', windows: [], unavailable: { reason: 'failed', message: 'HTTP 500' } };
    const failed = await get('/web/config/providers/anthropic/accounts/usage?refresh=1');
    expect(failed.body.accounts[account.id]).toMatchObject({
      stale: true,
      windows: [{ usedPercent: 42 }],
      unavailable: { reason: 'failed', message: 'HTTP 500' },
    });
    expect((await get('/web/config/providers/openai/accounts/usage')).status).toBe(404);
    expect((await get('/web/config/providers/anthropic/accounts/usage', null)).status).toBe(401);
  });

  it('sums a period by day, harness, model, account and Factory, with names for accounts and Factories', async () => {
    const { seed, get, addSignIn } = await setup();
    const account = await addSignIn('alice@example.com');
    const project = await seed.projects.create({ orgId: 'org1', userId: 'alice', input: { name: 'Payments' } });
    const factoryProjectId = project.id;
    await seed.usage.recordTurn(turn({ accountId: account.id, factoryProjectId }));
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
