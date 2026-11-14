import { describe, expect, it, vi } from 'vitest';

import type { AgentEvent } from '@factory/harness';
import type { TranscriptEntry } from '@factory/harness/transcript';
import { FACTORY_OPEN_RUNS_SETTING } from '@factory/runtime';
import { createFactoryStorageForTests } from '@factory/testing';
import type { SignInOAuth, SourceControlSession } from '@factory/store';

import { CLAUDE_OAUTH_USAGE_URL, createClaudeHarnessUsage } from '../claude/usage.ts';
import { CODEX_USAGE_URL, codexWhamUsageToLimits, createCodexHarnessUsage } from '../codex/usage.ts';
import { observeSessionUsage } from './recorder.ts';

function fakeSession(settings: Record<string, unknown> = {}) {
  const listeners = new Set<(event: AgentEvent) => void>();
  const transcript = new Set<(entry: TranscriptEntry, meta: { runId: string; threadId: string }) => void>();
  const session = {
    accountId: 'account-1' as string | undefined,
    thread: {
      getId: () => 'thread-1',
      getSetting: async ({ key }: { key: string }) => settings[key],
      setSetting: async ({ key, value }: { key: string; value: unknown }) => {
        settings[key] = value;
      },
    },
    subscribe(listener: (event: AgentEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onTranscript(listener: (entry: TranscriptEntry, meta: { runId: string; threadId: string }) => void) {
      transcript.add(listener);
      return () => transcript.delete(listener);
    },
  };
  return {
    session,
    emit: (event: AgentEvent | { type: string }) => listeners.forEach(listener => listener(event as AgentEvent)),
    entry: (entry: TranscriptEntry) => transcript.forEach(listener => listener(entry, { runId: 'run-7', threadId: 'thread-1' })),
  };
}

const row = { orgId: 'org-1', factoryProjectId: 'factory-1', userId: 'user-1' } as SourceControlSession;

async function settle() {
  for (let i = 0; i < 10; i += 1) await new Promise(resolve => setTimeout(resolve, 0));
}

describe('observeSessionUsage', () => {
  it('records each turn once, summed from its steps, with its card run and role, model, account and reported cost', async () => {
    const seed = await createFactoryStorageForTests();
    const { session, emit, entry } = fakeSession({
      [FACTORY_OPEN_RUNS_SETTING]: [
        {
          kickoffId: 'kick-1',
          bindingId: 'b',
          role: 'work',
          startedBy: 'user-1',
          orgId: 'org-1',
          factoryProjectId: 'factory-1',
          workItemId: 'card-1',
          sessionId: 'session-1',
          threadId: 'thread-1',
          branch: 'main',
        },
      ],
    });
    observeSessionUsage(session, { sessionId: 'session-1', harnessId: 'claude-code' }, {
      usage: seed.usage,
      sessions: { getBySessionId: async () => row },
      now: () => new Date('2026-11-02T10:00:00.000Z'),
    });

    entry({ kind: 'init', sessionId: 'cli-1', model: 'claude-sonnet-4-6' });
    emit({ type: 'usage_update', usage: { promptTokens: 10_000, completionTokens: 200, cachedInputTokens: 9_000, cacheCreationInputTokens: 500 } });
    emit({ type: 'usage_update', usage: { promptTokens: 12_000, completionTokens: 300, cachedInputTokens: 11_000, reasoningTokens: 50 } });
    entry({ kind: 'result', subtype: 'success', isError: false, costUsd: 0.04 });
    emit({ type: 'agent_end', reason: 'complete' });
    // An end with no steps (an aborted wait) records nothing.
    emit({ type: 'agent_end', reason: 'aborted' });
    await settle();

    const turns = await seed.usage.listSessionTurns('org-1', 'session-1');
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      harnessId: 'claude-code',
      model: 'claude-sonnet-4-6',
      accountId: 'account-1',
      runId: 'run-7',
      workItemId: 'card-1',
      kickoffId: 'kick-1',
      role: 'work',
      factoryProjectId: 'factory-1',
      userId: 'user-1',
      stepCount: 2,
      contextTokens: 12_000,
      reportedCostUsd: 0.04,
      totals: { inputTokens: 1_500, cacheReadTokens: 20_000, cacheWriteTokens: 500, outputTokens: 500, reasoningTokens: 50 },
    });
  });

  it('keeps the windows a turn is told on its account, and records nothing for a session without a row', async () => {
    const seed = await createFactoryStorageForTests();
    const { session, emit } = fakeSession();
    observeSessionUsage(session, { sessionId: 's', harnessId: 'codex', modelFor: async () => 'gpt-5.1-codex' }, {
      usage: seed.usage,
      sessions: { getBySessionId: async id => (id === 's' ? row : null) },
    });
    emit({ type: 'usage_limits_update', accountId: 'account-9', checkedAt: '2026-11-02T10:00:00.000Z', windows: [{ id: 'primary', kind: 'session', usedPercent: 33 }] });
    emit({ type: 'usage_update', usage: { promptTokens: 100, completionTokens: 10 } });
    emit({ type: 'agent_end', reason: 'suspended' });
    await settle();
    expect((await seed.usage.listAccountLimits('org-1', ['account-9'])).get('account-9')?.windows).toEqual([
      { id: 'primary', kind: 'session', usedPercent: 33 },
    ]);
    expect((await seed.usage.listSessionTurns('org-1', 's'))[0]).toMatchObject({ model: 'gpt-5.1-codex', workItemId: null });

    const orphan = fakeSession();
    observeSessionUsage(orphan.session, { sessionId: 'nobody', harnessId: 'mastra' }, { usage: seed.usage, sessions: { getBySessionId: async () => null } });
    orphan.emit({ type: 'usage_update', usage: { promptTokens: 1, completionTokens: 1 } });
    orphan.emit({ type: 'agent_end', reason: 'complete' });
    await settle();
    expect(await seed.usage.listTurns({ orgId: 'org-1', harnessId: 'mastra' })).toEqual([]);
  });
});

const oauth: SignInOAuth = { accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: 0, scopes: [], workspaceId: 'ws-1' };

describe('usage probes', () => {
  it("reads a Claude sign-in's windows from the usage endpoint with its own token", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        five_hour: { utilization: 61, resets_at: '2026-11-11T20:00:00Z' },
        seven_day: null,
        seven_day_opus: { utilization: 83, resets_at: '2026-11-15T08:00:00Z' },
        extra_usage: { is_enabled: true, used_credits: 2_500, monthly_limit: 10_000, utilization: 25 },
      }),
    );
    const usage = createClaudeHarnessUsage({ signIn: async () => oauth, fetch: fetchMock as never, now: () => new Date('2026-11-11T18:00:00Z') });
    const limits = await usage.readAccountLimits!({ orgId: 'org-1', accountId: 'a' });
    expect(limits).toMatchObject({
      source: 'probe',
      windows: [
        { id: 'five_hour', kind: 'session', usedPercent: 61 },
        { id: 'seven_day_opus', kind: 'model', label: 'Opus', usedPercent: 83 },
        { id: 'monthly_spend', kind: 'spend', usedPercent: 25 },
      ],
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(CLAUDE_OAUTH_USAGE_URL);
    expect(init.headers).toMatchObject({ authorization: 'Bearer access-1', 'anthropic-beta': 'oauth-2025-04-20' });
  });

  it("reads a ChatGPT sign-in's windows with its workspace, and says when a probe cannot run", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        plan_type: 'plus',
        rate_limit: {
          primary_window: { used_percent: 12, limit_window_seconds: 18_000, reset_after_seconds: 600 },
          secondary_window: { used_percent: 48, limit_window_seconds: 604_800, reset_at: 1_793_000_000 },
        },
      }),
    );
    const usage = createCodexHarnessUsage({ signIn: async () => oauth, fetch: fetchMock as never, now: () => new Date('2026-11-11T18:00:00Z') });
    expect(await usage.readAccountLimits!({ orgId: 'org-1', accountId: 'a' })).toEqual({
      checkedAt: '2026-11-11T18:00:00.000Z',
      source: 'probe',
      windows: [
        { id: 'primary', kind: 'session', usedPercent: 12, windowDurationMins: 300, resetsAt: '2026-11-11T18:10:00.000Z' },
        { id: 'secondary', kind: 'weekly', usedPercent: 48, windowDurationMins: 10080, resetsAt: new Date(1_793_000_000_000).toISOString() },
      ],
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(CODEX_USAGE_URL);
    expect(init.headers).toMatchObject({ 'chatgpt-account-id': 'ws-1' });

    const signedOut = createCodexHarnessUsage({ signIn: async () => undefined, fetch: fetchMock as never });
    expect((await signedOut.readAccountLimits!({ orgId: 'o', accountId: 'a' })).unavailable).toEqual({ reason: 'signed_out' });
    const refused = createClaudeHarnessUsage({ signIn: async () => oauth, fetch: (async () => new Response('no', { status: 401 })) as never });
    expect((await refused.readAccountLimits!({ orgId: 'o', accountId: 'a' })).unavailable).toEqual({
      reason: 'failed',
      message: 'The provider answered HTTP 401.',
    });
    expect(codexWhamUsageToLimits({}, '2026-11-11T18:00:00.000Z').unavailable).toEqual({ reason: 'unsupported' });
  });
});
