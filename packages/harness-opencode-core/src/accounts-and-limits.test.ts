import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentEvent, AgentRunContext } from '@factory/harness';
import type { TranscriptEntry } from '@factory/harness/transcript';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openCodeAuthContent } from './env.ts';
import { createOpenCodeHarness } from './harness.ts';
import { openCodeCatalogModels } from './models.ts';
import type { OpenCodeSession, OpenCodeSessionConfig } from './session.ts';
import { createInMemoryOpenCodeSessionStore } from './store.ts';
import { startFakeOpenCode, type FakeOpenCode } from './testkit.ts';
import { exhaustedUntil, openCodeGoUsageToLimits, readOpenCodeAccountLimits } from './usage.ts';

const context: AgentRunContext = { get: () => undefined };

let fake: FakeOpenCode;
let root: string;

beforeEach(async () => {
  fake = await startFakeOpenCode();
  root = await mkdtemp(join(tmpdir(), 'opencode-accounts-'));
});

afterEach(async () => {
  await fake.close();
});

async function session(config: Partial<OpenCodeSessionConfig> = {}): Promise<{ session: OpenCodeSession; entries: TranscriptEntry[]; events: AgentEvent[] }> {
  const work = await mkdtemp(join(root, 'work-'));
  const harness = createOpenCodeHarness({
    store: createInMemoryOpenCodeSessionStore(),
    cwdFor: () => work,
    stateRootFor: s => join(root, 'state', s.id),
    spawn: fake.spawn,
    env: { PATH: '/usr/bin', HOME: '/home/agent' },
    turnSelectionFor: () => ({ model: 'opencode/big-pickle' }),
    ...config,
  });
  const created = await harness.createSession({ sessionId: 'session-1', threadId: 'thread-1' });
  const entries: TranscriptEntry[] = [];
  const events: AgentEvent[] = [];
  created.onTranscript(entry => entries.push(entry));
  created.subscribe(event => events.push(event));
  return { session: created, entries, events };
}

const limitReached = (sessionId: string) =>
  fake.emit({ type: 'session.status', properties: { sessionID: sessionId, status: { type: 'retry', attempt: 1, message: 'Usage limit reached for OpenCode Go.', next: 1000 } } });

describe('OpenCode accounts on a run', () => {
  it('signs the run in with the account key inline, and says which account it runs on', async () => {
    fake.onPrompt = ({ sessionId }) => fake.idle(sessionId);
    const { session: s, entries } = await session({
      credentials: async () => ({ accountId: 'acc-1', apiKey: 'sk-test-key', credential: { label: 'Team OpenCode' } }),
    });
    expect(await s.sendMessage({ content: 'hi', requestContext: context })).toEqual({ reason: 'complete' });
    const env = fake.spawns[0]!.env;
    expect(JSON.parse(env.OPENCODE_AUTH_CONTENT!)).toEqual({ opencode: { type: 'api', key: 'sk-test-key' }, 'opencode-go': { type: 'api', key: 'sk-test-key' } });
    expect(entries).toContainEqual({ kind: 'credential', label: 'Team OpenCode' });
    expect(s.accountId).toBe('acc-1');
  });

  it('runs signed in with nothing when there is no account', async () => {
    fake.onPrompt = ({ sessionId }) => fake.idle(sessionId);
    const { session: s } = await session({ credentials: async () => undefined });
    expect(await s.sendMessage({ content: 'hi', requestContext: context })).toEqual({ reason: 'complete' });
    expect(fake.spawns[0]!.env.OPENCODE_AUTH_CONTENT).toBeUndefined();
    expect(s.accountId).toBeUndefined();
  });

  it('parks a chat session until the account comes back when the reset is known, and tells the pool', async () => {
    fake.onPrompt = ({ sessionId }) => limitReached(sessionId);
    const resetsAt = new Date(Date.now() + 60 * 60_000);
    const failures: Array<{ accountId: string; kind: string; resetsAt?: string }> = [];
    const { session: s, events } = await session({
      credentials: async () => ({ accountId: 'acc-1', apiKey: 'sk-test-key', credential: { label: 'Go' } }),
      usageLimitResetsAt: async (_session, failure) => (failure.accountId === 'acc-1' ? resetsAt : undefined),
      onCredentialFailure: (_session, { accountId, error }) => {
        failures.push({ accountId, kind: error.kind, ...(error.resetsAt ? { resetsAt: error.resetsAt.toISOString() } : {}) });
      },
      parkOnUsageLimit: () => true,
    });
    expect(await s.sendMessage({ content: 'hi', requestContext: context })).toEqual({ reason: 'error' });
    expect(failures).toEqual([{ accountId: 'acc-1', kind: 'rate_limit', resetsAt: resetsAt.toISOString() }]);
    expect(s.usageLimitPark).toMatchObject({ reason: 'usage_limit', until: resetsAt.toISOString(), resetKnown: true, attempts: 1 });
    expect(events.some(event => event.type === 'error')).toBe(false);
    expect(events.map(event => event.type)).toContain('usage_limit_parked');
  });

  it('fails a free-model run whose limit says no reset time, instead of parking on a guess', async () => {
    fake.onPrompt = ({ sessionId }) => limitReached(sessionId);
    const { session: s, events } = await session({
      credentials: async () => undefined,
      usageLimitResetsAt: async () => undefined,
      parkOnUsageLimit: () => true,
    });
    expect(await s.sendMessage({ content: 'hi', requestContext: context })).toEqual({ reason: 'error' });
    expect(s.usageLimitPark).toBeUndefined();
    expect((events.find(event => event.type === 'error') as { error: { kind: string } }).error.kind).toBe('rate_limit');
  });

  it('resumes a parked session: the next run takes the park up', async () => {
    let calls = 0;
    fake.onPrompt = ({ sessionId }) => {
      calls += 1;
      if (calls === 1) limitReached(sessionId);
      else fake.idle(sessionId);
    };
    const { session: s, events } = await session({
      credentials: async () => ({ accountId: 'acc-1', apiKey: 'sk-test-key', credential: { label: 'Go' } }),
      usageLimitResetsAt: async () => new Date(Date.now() + 1000),
      parkOnUsageLimit: () => true,
    });
    await s.sendMessage({ content: 'hi', requestContext: context });
    expect(s.usageLimitPark).toBeDefined();
    const resumed = await s.resumeFromUsageLimit();
    expect(resumed.action).toBe('resumed');
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(s.usageLimitPark).toBeUndefined();
    expect(events.map(event => event.type)).toContain('usage_limit_cleared');
  });

  it('refuses imported history once the session ran', async () => {
    fake.onPrompt = ({ sessionId }) => fake.idle(sessionId);
    const { session: s } = await session();
    await s.sendMessage({ content: 'hi', requestContext: context });
    await expect(s.importHistory([], { openCodeSessionId: 'ses_1', directory: '/x', title: 'x' })).rejects.toThrow(/not run yet/);
  });

  it('writes imported history into the thread as turns', async () => {
    const { session: s, entries } = await session();
    await s.importHistory(
      [{ input: 'Fix the bug', model: 'opencode/big-pickle', entries: [{ kind: 'text', text: 'Fixed.' }] }],
      { openCodeSessionId: 'ses_1', directory: '/work/app', title: 'Bug fix' },
    );
    expect(entries.map(entry => entry.kind)).toEqual(['input', 'init', 'text', 'result']);
    expect(s.importedFrom).toMatchObject({ openCodeSessionId: 'ses_1', directory: '/work/app', title: 'Bug fix' });
  });
});

describe('OpenCode account usage', () => {
  it('reads OpenCode Go windows', () => {
    const limits = openCodeGoUsageToLimits(
      {
        usage: {
          rolling: { percent: 40, resetsAt: '2026-11-14T20:00:00Z' },
          weekly: { percent: 100, resetsAt: '2026-11-17T00:00:00Z' },
          monthly: { percent: 10, resetsAt: '2026-12-01T00:00:00Z' },
        },
      },
      '2026-11-14T18:00:00.000Z',
    );
    expect(limits.windows.map(window => [window.id, window.kind, window.usedPercent])).toEqual([
      ['go_rolling', 'session', 40],
      ['go_weekly', 'weekly', 100],
      ['go_monthly', 'monthly', 10],
    ]);
    expect(exhaustedUntil(limits, new Date('2026-11-14T18:00:00Z'))?.toISOString()).toBe('2026-11-17T00:00:00.000Z');
  });

  it('tells a key without Go, a refused key and a failure apart', async () => {
    const answer = (status: number) => (async () => new Response('{}', { status })) as unknown as typeof fetch;
    expect((await readOpenCodeAccountLimits('k', { fetch: answer(403) })).unavailable?.reason).toBe('unsupported');
    expect((await readOpenCodeAccountLimits('k', { fetch: answer(401) })).unavailable?.reason).toBe('signed_out');
    expect((await readOpenCodeAccountLimits('k', { fetch: answer(500) })).unavailable?.reason).toBe('failed');
  });

  it('never accepts an empty key for a run', () => {
    expect(() => openCodeAuthContent('  ')).toThrow();
  });
});

describe('OpenCode catalog with an account', () => {
  const list = {
    all: [
      {
        id: 'opencode',
        name: 'OpenCode Zen',
        models: {
          'big-pickle': { id: 'big-pickle', name: 'Big Pickle', cost: { input: 0, output: 0 } },
          'claude-sonnet-5': { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', cost: { input: 3, output: 15 } },
          'old-free': { id: 'old-free', name: 'Old', cost: { input: 0, output: 0 }, status: 'deprecated' },
        },
      },
      { id: 'opencode-go', name: 'OpenCode Go', models: { 'kimi-k3': { id: 'kimi-k3', name: 'Kimi K3', cost: { input: 1, output: 2 } } } },
    ],
    connected: [],
    default: {},
  } as never;

  it('lists the free models alone without an account', () => {
    expect(openCodeCatalogModels(list).map(model => [model.slug, model.badge])).toEqual([['opencode/big-pickle', 'free']]);
  });

  it('adds the paid Zen models and OpenCode Go once signed in, free ones still marked', () => {
    expect(openCodeCatalogModels(list, { signedIn: true }).map(model => [model.slug, model.badge ?? null])).toEqual([
      ['opencode/big-pickle', 'free'],
      ['opencode/claude-sonnet-5', null],
      ['opencode-go/kimi-k3', null],
    ]);
  });
});
