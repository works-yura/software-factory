import { describe, expect, it } from 'vitest';

import { OpenCodeError, OPENCODE_GO_USAGE_URL } from '@factory/harness-opencode';
import { createFactoryStorageForTests } from '@factory/testing';

import { DEFAULT_ACCOUNT_LIMIT_COOLDOWN_MS } from '../accounts/pool.ts';
import { createOpenCodeAccounts, createOpenCodeHarnessUsage, OPENCODE_ACCOUNT_PROVIDER } from './accounts.ts';

const now = new Date('2026-11-14T12:00:00Z');
const tenant = { orgId: 'org-1', userId: 'alice' };

async function seeded() {
  const storage = await createFactoryStorageForTests();
  const store = storage.credentials;
  const add = (label: string, secret: string, priority = 0) =>
    store.addAccount({ orgId: 'org-1', provider: OPENCODE_ACCOUNT_PROVIDER, label, kind: 'api_key', secret, priority, createdBy: 'alice' });
  return { store, add };
}

/** OpenCode Go's usage endpoint as a fetch: per key, a status and the windows. */
function goUsage(byKey: Record<string, { status: number; weekly?: number }>): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    expect(url).toBe(OPENCODE_GO_USAGE_URL);
    const key = String((init?.headers as Record<string, string>).authorization).replace(/^Bearer /, '');
    const answer = byKey[key] ?? { status: 401 };
    if (answer.status !== 200) return new Response('{}', { status: answer.status });
    return Response.json({
      usage: {
        rolling: { percent: 10, resetsAt: '2026-11-14T15:00:00Z' },
        weekly: { percent: answer.weekly ?? 20, resetsAt: '2026-11-17T00:00:00Z' },
        monthly: { percent: 5, resetsAt: '2026-12-01T00:00:00Z' },
      },
    });
  }) as unknown as typeof fetch;
}

describe('OpenCode accounts', () => {
  it('runs signed in with nothing (the free models) when the organization has no account', async () => {
    const { store } = await seeded();
    const accounts = createOpenCodeAccounts({ credentials: store, now: () => now });
    expect(await accounts.credentials(tenant)).toBeUndefined();
    expect(await accounts.catalogAccount('org-1')).toBeUndefined();
  });

  it('hands a run an account key, the session’s last one first, and names it', async () => {
    const { store, add } = await seeded();
    await add('First', 'sk-first', 0);
    const second = await add('Second', 'sk-second', 1);
    const accounts = createOpenCodeAccounts({ credentials: store, now: () => now });
    expect(await accounts.credentials(tenant)).toMatchObject({ apiKey: 'sk-first', credential: { label: 'First' } });
    expect(await accounts.credentials(tenant, { preferredAccountId: second.id, exclude: [] })).toMatchObject({ accountId: second.id, apiKey: 'sk-second' });
    // A card run (the Factory's own) may use the organization's keys too.
    expect(await accounts.credentials({ orgId: 'org-1', userId: 'factory-project:prj-1' })).toBeDefined();
  });

  it('takes a limited account out until its reset, and stops (with when) once every account is out', async () => {
    const { store, add } = await seeded();
    const only = await add('Only', 'sk-only');
    const accounts = createOpenCodeAccounts({ credentials: store, now: () => now });
    const resetsAt = new Date('2026-11-17T00:00:00Z');
    await accounts.onCredentialFailure(tenant, { accountId: only.id, error: new OpenCodeError('rate_limit', 'Go limit', { resetsAt }) });
    expect((await store.getAccount('org-1', only.id))?.limitedUntil?.toISOString()).toBe(resetsAt.toISOString());
    await expect(accounts.credentials(tenant)).rejects.toMatchObject({ kind: 'rate_limit', resetsAt });
  });

  it('sits a limited account out for the default cooldown when nobody said when', async () => {
    const { store, add } = await seeded();
    const only = await add('Only', 'sk-only');
    const accounts = createOpenCodeAccounts({ credentials: store, now: () => now });
    await accounts.onCredentialFailure(tenant, { accountId: only.id, error: new OpenCodeError('rate_limit', 'limit') });
    expect((await store.getAccount('org-1', only.id))?.limitedUntil?.getTime()).toBe(now.getTime() + DEFAULT_ACCOUNT_LIMIT_COOLDOWN_MS);
  });

  it('turns a refused key off and says so instead of running on the free models', async () => {
    const { store, add } = await seeded();
    const only = await add('Only', 'sk-only');
    const accounts = createOpenCodeAccounts({ credentials: store, now: () => now });
    await accounts.onCredentialFailure(tenant, { accountId: only.id, error: new OpenCodeError('auth', 'Invalid API key') });
    expect((await store.getAccount('org-1', only.id))?.disabled).toBe(true);
    await expect(accounts.credentials(tenant)).rejects.toMatchObject({ kind: 'auth' });
  });

  it('knows when usage comes back: now with another account free, else the account’s used-up Go window', async () => {
    const { store, add } = await seeded();
    const first = await add('First', 'sk-first', 0);
    const accounts = createOpenCodeAccounts({ credentials: store, now: () => now, fetch: goUsage({ 'sk-first': { status: 200, weekly: 100 } }) });
    expect((await accounts.resetsAt(tenant, { accountId: first.id }))?.toISOString()).toBe('2026-11-17T00:00:00.000Z');
    await add('Second', 'sk-second', 1);
    expect(await accounts.resetsAt(tenant, { accountId: first.id })).toEqual(now);
    expect(await accounts.resetsAt(tenant, {})).toBeUndefined();
  });

  it('reads an account’s OpenCode Go windows for the usage views, and none for a key without Go', async () => {
    const { store, add } = await seeded();
    const go = await add('Go', 'sk-go');
    const zen = await add('Zen', 'sk-zen');
    const accounts = createOpenCodeAccounts({ credentials: store, now: () => now });
    const usage = createOpenCodeHarnessUsage(accounts, { fetch: goUsage({ 'sk-go': { status: 200 }, 'sk-zen': { status: 403 } }), now: () => now });
    expect(usage).toMatchObject({ harnessId: 'opencode', accountProvider: 'opencode' });
    expect((await usage.readAccountLimits!({ orgId: 'org-1', accountId: go.id })).windows.map(window => window.id)).toEqual(['go_rolling', 'go_weekly', 'go_monthly']);
    expect((await usage.readAccountLimits!({ orgId: 'org-1', accountId: zen.id })).unavailable?.reason).toBe('unsupported');
    expect((await usage.readAccountLimits!({ orgId: 'org-1', accountId: 'missing' })).unavailable?.reason).toBe('signed_out');
  });
});
