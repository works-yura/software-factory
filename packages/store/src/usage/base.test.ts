import { randomUUID } from 'node:crypto';

import { LibSQLFactoryStorage } from '@mastra/libsql';
import { PgFactoryStorage } from '@mastra/pg';
import { describe, expect, it, onTestFinished } from 'vitest';

import { summarizeUsage, utcDay } from '@factory/harness/usage';

import type { RecordUsageTurnInput } from './base.ts';
import { UsageStorage } from './base.ts';

// Set FACTORY_TEST_POSTGRES_URL to a disposable database to also run on PostgreSQL.
const postgresUrl = process.env.FACTORY_TEST_POSTGRES_URL;

describe.each(['libsql', ...(postgresUrl ? ['postgres'] : [])])('UsageStorage on %s', backend => {
  async function makeStorage() {
    const storage =
      backend === 'postgres'
        ? new PgFactoryStorage({ id: 'usage-test', connectionString: postgresUrl! })
        : new LibSQLFactoryStorage({ id: 'usage-test', url: ':memory:' });
    const usage = storage.registerDomain(new UsageStorage());
    await storage.init();
    onTestFinished(() => storage.close());
    return { usage, orgId: `org-${randomUUID()}` };
  }

  const turn = (orgId: string, overrides: Partial<RecordUsageTurnInput> = {}): RecordUsageTurnInput => ({
    orgId,
    sessionId: 'session-1',
    threadId: 'thread-1',
    runId: 'run-1',
    factoryProjectId: 'factory-1',
    workItemId: null,
    kickoffId: null,
    role: null,
    userId: 'user-1',
    harnessId: 'claude-code',
    model: 'claude-sonnet-4-6',
    accountId: 'account-1',
    occurredAt: '2026-11-02T10:00:00.000Z',
    totals: { inputTokens: 1200, cacheReadTokens: 30_000, cacheWriteTokens: 800, outputTokens: 450, reasoningTokens: 100 },
    stepCount: 3,
    contextTokens: 32_000,
    reportedCostUsd: 0.0123,
    ...overrides,
  });

  it('records a turn and reads it back whole, its day filed in UTC', async () => {
    const { usage, orgId } = await makeStorage();
    const recorded = await usage.recordTurn(turn(orgId, { occurredAt: '2026-11-02T23:30:00.000-02:00' }));
    expect(recorded).toEqual({
      id: expect.any(String),
      sessionId: 'session-1',
      threadId: 'thread-1',
      runId: 'run-1',
      factoryProjectId: 'factory-1',
      workItemId: null,
      kickoffId: null,
      role: null,
      userId: 'user-1',
      harnessId: 'claude-code',
      model: 'claude-sonnet-4-6',
      accountId: 'account-1',
      occurredAt: '2026-11-03T01:30:00.000Z',
      totals: { inputTokens: 1200, cacheReadTokens: 30_000, cacheWriteTokens: 800, outputTokens: 450, reasoningTokens: 100 },
      stepCount: 3,
      contextTokens: 32_000,
      reportedCostUsd: 0.0123,
    });
    expect(await usage.listTurns({ orgId, days: ['2026-11-03'] })).toEqual([recorded]);
    expect(await usage.listTurns({ orgId, days: ['2026-11-02'] })).toEqual([]);
  });

  it('reads a period by day and filter, sessions and cards apart, never another organization’s', async () => {
    const { usage, orgId } = await makeStorage();
    await usage.recordTurn(turn(orgId));
    await usage.recordTurn(turn(orgId, { occurredAt: '2026-11-04T08:00:00.000Z', harnessId: 'codex', model: 'gpt-5.1-codex', reportedCostUsd: null }));
    await usage.recordTurn(
      turn(orgId, { sessionId: 'session-2', workItemId: 'card-1', kickoffId: 'kick-1', role: 'implementer', occurredAt: '2026-11-05T08:00:00.000Z' }),
    );
    await usage.recordTurn(turn(`${orgId}-other`));

    const days = ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04'];
    expect((await usage.listTurns({ orgId, days })).map(entry => entry.harnessId)).toEqual(['claude-code', 'codex']);
    expect((await usage.listTurns({ orgId, harnessId: 'codex' })).map(entry => entry.model)).toEqual(['gpt-5.1-codex']);
    expect(await usage.listTurns({ orgId })).toHaveLength(3);
    expect((await usage.listSessionTurns(orgId, 'session-1')).map(entry => utcDay(entry.occurredAt))).toEqual([
      '2026-11-02',
      '2026-11-04',
    ]);
    expect((await usage.listWorkItemTurns(orgId, ['card-1', 'card-2'])).map(entry => [entry.kickoffId, entry.role])).toEqual([['kick-1', 'implementer']]);

    const summary = summarizeUsage(await usage.listTurns({ orgId, days }), { from: '2026-11-01', to: '2026-11-04' });
    expect(summary.total.turns).toBe(2);
    expect(summary.byHarness.map(group => group.key).sort()).toEqual(['claude-code', 'codex']);
  });

  it('keeps an account’s last windows: a probe replaces them, a turn’s update merges and never goes back in time', async () => {
    const { usage, orgId } = await makeStorage();
    await usage.saveAccountLimits(orgId, 'account-1', {
      checkedAt: '2026-11-02T10:00:00.000Z',
      source: 'probe',
      windows: [
        { id: 'five_hour', kind: 'session', usedPercent: 10 },
        { id: 'seven_day', kind: 'weekly', usedPercent: 30 },
      ],
    });
    const merged = await usage.mergeAccountLimits(orgId, 'account-1', {
      checkedAt: '2026-11-02T11:00:00.000Z',
      windows: [{ id: 'five_hour', kind: 'session', usedPercent: 64, resetsAt: '2026-11-02T15:00:00.000Z' }],
    });
    expect(merged).toEqual({
      checkedAt: '2026-11-02T11:00:00.000Z',
      source: 'stream',
      windows: [
        { id: 'five_hour', kind: 'session', usedPercent: 64, resetsAt: '2026-11-02T15:00:00.000Z' },
        { id: 'seven_day', kind: 'weekly', usedPercent: 30 },
      ],
    });
    const stale = await usage.mergeAccountLimits(orgId, 'account-1', {
      checkedAt: '2026-11-02T09:00:00.000Z',
      windows: [{ id: 'five_hour', kind: 'session', usedPercent: 1 }],
    });
    expect(stale.windows[0]?.usedPercent).toBe(64);

    await usage.mergeAccountLimits(orgId, 'account-2', { checkedAt: '2026-11-02T11:00:00.000Z', windows: [{ id: 'primary', kind: 'session', usedPercent: 5 }] });
    await usage.saveAccountLimits(orgId, 'account-3', {
      checkedAt: '2026-11-02T11:00:00.000Z',
      source: 'probe',
      windows: [],
      unavailable: { reason: 'failed', message: 'HTTP 500' },
    });
    const listed = await usage.listAccountLimits(orgId, ['account-1', 'account-2', 'account-3', 'missing']);
    expect([...listed.keys()].sort()).toEqual(['account-1', 'account-2', 'account-3']);
    expect(listed.get('account-3')?.unavailable).toEqual({ reason: 'failed', message: 'HTTP 500' });
    expect(listed.get('account-2')?.source).toBe('stream');
  });
});
