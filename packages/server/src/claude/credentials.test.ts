import { describe, expect, it, vi } from 'vitest';

import { createFactoryStorageForTests } from '@factory/testing';
import type { ClaudeLoginOAuth } from '@factory/store';

import { ClaudeCodeError } from '@factory/harness-claude-code';

import {
  ClaudeCodeCredentialMissingError,
  createClaudeCodeCredentials,
  createClaudeCodeCredentialsHook,
  DEFAULT_ACCOUNT_LIMIT_COOLDOWN_MS,
} from './credentials.ts';
import { CLAUDE_OAUTH_CLIENT_ID, CLAUDE_OAUTH_REFRESH_MARGIN_MS, CLAUDE_OAUTH_TOKEN_URL } from './oauth.ts';

describe('Claude Code credentials hook', () => {
  const now = new Date('2026-10-28T12:00:00Z');
  const missing = 'No Claude sign-in is set for organization org-1. Sign in to Claude under Settings → Models → Claude Code accounts to run Claude Code sessions.';

  it('never falls back to the person’s own claude login: with nothing stored it asks for a sign-in', async () => {
    const hook = createClaudeCodeCredentialsHook({ credentials: undefined });
    const failure = hook({ orgId: 'org-1', userId: 'user-1' });
    await expect(failure).rejects.toBeInstanceOf(ClaudeCodeCredentialMissingError);
    await expect(failure).rejects.toThrow(missing);
  });

  it('never runs on the organization’s or a person’s Anthropic key for Mastra runs', async () => {
    const seeded = await createFactoryStorageForTests();
    await seeded.credentials.setCredential({ orgId: 'org-1' }, 'anthropic', { type: 'api_key', key: 'sk-ant-api03-x' });
    await seeded.credentials.setCredential({ orgId: 'org-1', userId: 'user-1' }, 'anthropic', {
      type: 'api_key',
      key: 'sk-ant-oat01-personal',
    });
    const hook = createClaudeCodeCredentialsHook({ credentials: seeded.credentials });
    await expect(hook({ orgId: 'org-1', userId: 'user-1' })).rejects.toThrow(missing);
  });

  it('ignores pasted setup tokens and API keys left from before, and runs on a sign-in alone', async () => {
    const seeded = await createFactoryStorageForTests();
    const accounts = seeded.credentials;
    for (const [label, kind, secret] of [
      ['Old key', 'api_key', 'sk-ant-api03-aaaaaaaaaaaaaaaaaaaa1111'],
      ['Old Max', 'subscription', 'sk-ant-oat01-bbbbbbbbbbbbbbbbbbbb2222'],
    ] as const) {
      await accounts.addAccount({
        orgId: 'org-1',
        provider: 'anthropic',
        label,
        kind,
        secret,
        priority: -100,
        createdBy: 'alice',
        ...(kind === 'subscription' ? { ownerUserId: 'alice' } : {}),
      });
    }
    const { credentials } = createClaudeCodeCredentials({ credentials: accounts, now: () => now });
    await expect(credentials({ orgId: 'org-1', userId: 'alice' })).rejects.toBeInstanceOf(ClaudeCodeCredentialMissingError);

    const signIn = await accounts.addAccount({
      orgId: 'org-1',
      provider: 'anthropic',
      label: 'alice@example.com',
      kind: 'claude_login',
      ownerUserId: 'alice',
      secret: 'fake-access-1',
      oauth: { accessToken: 'fake-access-1', refreshToken: 'fake-refresh-1', expiresAt: now.getTime() + 3_600_000, scopes: [] },
      createdBy: 'alice',
    });
    await expect(credentials({ orgId: 'org-1', userId: 'alice' })).resolves.toEqual({
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'fake-access-1' },
      accountId: signIn.id,
      credential: { label: 'alice@example.com', ownerId: 'alice' },
    });
  });
});

describe('Claude Code credential accounts', () => {
  const now = new Date('2026-10-28T12:00:00Z');

  async function pool() {
    const seeded = await createFactoryStorageForTests();
    const accounts = seeded.credentials;
    const add = (label: string, ownerUserId: string, priority = 0) =>
      accounts.addAccount({
        orgId: 'org-1',
        provider: 'anthropic',
        label,
        kind: 'claude_login',
        ownerUserId,
        priority,
        secret: `fake-access-${label}`,
        oauth: {
          accessToken: `fake-access-${label}`,
          refreshToken: `fake-refresh-${label}`,
          expiresAt: now.getTime() + 3_600_000,
          scopes: [],
        },
        createdBy: ownerUserId,
      });
    const hooks = createClaudeCodeCredentials({ credentials: accounts, now: () => now });
    return { accounts, add, ...hooks };
  }

  it('gives a run its owner’s sign-in and names the account, never another person’s', async () => {
    const { add, credentials, accounts } = await pool();
    const alice = await add('alice', 'alice');

    await expect(credentials({ orgId: 'org-1', userId: 'alice' }, { exclude: [] })).resolves.toEqual({
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'fake-access-alice' },
      accountId: alice.id,
      credential: { label: 'alice', ownerId: 'alice' },
    });
    expect((await accounts.getAccount('org-1', alice.id))?.lastUsedAt).toEqual(now);
    await expect(credentials({ orgId: 'org-1', userId: 'bob' }, { exclude: [] })).rejects.toBeInstanceOf(
      ClaudeCodeCredentialMissingError,
    );
  });

  it('gives a run the sign-in it asked for by id', async () => {
    const { add, credentials } = await pool();
    await add('first', 'alice');
    const second = await add('second', 'alice', 5);
    await expect(
      credentials({ orgId: 'org-1', userId: 'alice' }, { exclude: [], preferredAccountId: second.id }),
    ).resolves.toEqual({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'fake-access-second' }, accountId: second.id, credential: { label: 'second', ownerId: 'alice' } });
  });

  it('sets an account aside until its reset and moves to the next', async () => {
    const { add, credentials, onCredentialFailure, accounts } = await pool();
    const first = await add('first', 'alice');
    const second = await add('second', 'alice', 1);
    const resetsAt = new Date(now.getTime() + 2 * 3_600_000);

    await onCredentialFailure(
      { orgId: 'org-1', userId: 'alice' },
      { accountId: first.id, error: new ClaudeCodeError('rate_limit', 'limit', { resetsAt, now }) },
    );
    expect((await accounts.getAccount('org-1', first.id))?.limitedUntil).toEqual(resetsAt);
    await expect(credentials({ orgId: 'org-1', userId: 'alice' }, { exclude: [first.id] })).resolves.toMatchObject({
      accountId: second.id,
    });
    // A later turn of another session also skips it while it is limited.
    await expect(credentials({ orgId: 'org-1', userId: 'alice' }, { exclude: [] })).resolves.toMatchObject({
      accountId: second.id,
    });
  });

  it('sits an account out for the default cooldown when no reset was given', async () => {
    const { add, onCredentialFailure, accounts } = await pool();
    const first = await add('first', 'alice');
    await onCredentialFailure(
      { orgId: 'org-1', userId: 'alice' },
      { accountId: first.id, error: new ClaudeCodeError('rate_limit', 'limit') },
    );
    expect((await accounts.getAccount('org-1', first.id))?.limitedUntil).toEqual(
      new Date(now.getTime() + DEFAULT_ACCOUNT_LIMIT_COOLDOWN_MS),
    );
  });

  it('turns off a refused account and ignores failures that are not the account’s', async () => {
    const { add, onCredentialFailure, accounts } = await pool();
    const first = await add('first', 'alice');
    await onCredentialFailure(
      { orgId: 'org-1', userId: 'alice' },
      { accountId: first.id, error: new ClaudeCodeError('failed', 'boom') },
    );
    expect((await accounts.getAccount('org-1', first.id))?.disabled).toBe(false);
    await onCredentialFailure(
      { orgId: 'org-1', userId: 'alice' },
      { accountId: first.id, error: new ClaudeCodeError('auth', 'Invalid token') },
    );
    expect(await accounts.getAccount('org-1', first.id)).toMatchObject({ disabled: true, lastError: 'Invalid token' });
  });

  it('fails with the earliest reset when every account is out of usage', async () => {
    const { add, credentials, onCredentialFailure } = await pool();
    const first = await add('first', 'alice');
    const resetsAt = new Date(now.getTime() + 3_600_000);
    await onCredentialFailure(
      { orgId: 'org-1', userId: 'alice' },
      { accountId: first.id, error: new ClaudeCodeError('rate_limit', 'limit', { resetsAt, now }) },
    );

    const error = await credentials({ orgId: 'org-1', userId: 'alice' }, { exclude: [first.id] }).catch(e => e);
    expect(error).toBeInstanceOf(ClaudeCodeError);
    expect(error).toMatchObject({ kind: 'rate_limit', resetsAt });
  });

  it('has nothing to fall back on once the only sign-in failed this turn', async () => {
    const { add, credentials, onCredentialFailure, accounts } = await pool();
    await accounts.setCredential({ orgId: 'org-1' }, 'anthropic', { type: 'api_key', key: 'sk-ant-api03-legacy' });
    const first = await add('first', 'alice');
    await onCredentialFailure(
      { orgId: 'org-1', userId: 'alice' },
      { accountId: first.id, error: new ClaudeCodeError('auth', 'Invalid token') },
    );

    await expect(credentials({ orgId: 'org-1', userId: 'alice' }, { exclude: [first.id] })).rejects.toMatchObject({
      kind: 'auth',
      message: 'No other Claude account is available for this run.',
    });
    // A new turn with nothing tried still never uses the organization's Anthropic key.
    await expect(credentials({ orgId: 'org-1', userId: 'alice' }, { exclude: [] })).rejects.toBeInstanceOf(
      ClaudeCodeCredentialMissingError,
    );
  });
});

describe('Claude sign-in accounts', () => {
  const now = new Date('2026-10-28T12:00:00Z');
  const signIn = (overrides: Partial<ClaudeLoginOAuth> = {}): ClaudeLoginOAuth => ({
    accessToken: 'fake-access-1',
    refreshToken: 'fake-refresh-1',
    expiresAt: now.getTime() + 60 * 60_000,
    scopes: ['user:inference'],
    email: 'alice@example.com',
    ...overrides,
  });

  async function signInPool(fetchImpl: typeof fetch) {
    const seeded = await createFactoryStorageForTests();
    const accounts = seeded.credentials;
    const addSignIn = (oauth: ClaudeLoginOAuth, ownerUserId = 'alice') =>
      accounts.addAccount({
        orgId: 'org-1',
        provider: 'anthropic',
        label: oauth.email ?? 'Claude',
        kind: 'claude_login',
        ownerUserId,
        secret: oauth.accessToken,
        oauth,
        createdBy: ownerUserId,
      });
    const hooks = createClaudeCodeCredentials({ credentials: accounts, now: () => now, fetch: fetchImpl });
    return { accounts, addSignIn, ...hooks };
  }

  const tokenEndpoint = (respond: () => Response) => {
    const calls: URLSearchParams[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe(CLAUDE_OAUTH_TOKEN_URL);
      calls.push(new URLSearchParams(String(init?.body)));
      return respond();
    }) as typeof fetch;
    return { calls, fetchImpl };
  };

  it('hands a fresh sign-in’s access token to the run without refreshing it', async () => {
    const endpoint = tokenEndpoint(() => Response.json({}));
    const { addSignIn, credentials } = await signInPool(endpoint.fetchImpl);
    const account = await addSignIn(signIn());

    await expect(credentials({ orgId: 'org-1', userId: 'alice' })).resolves.toEqual({
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'fake-access-1' },
      accountId: account.id,
      credential: expect.any(Object),
    });
    expect(endpoint.calls).toHaveLength(0);
  });

  it('refreshes a sign-in about to expire, keeps the rotated pair, and never hands out the refresh token', async () => {
    const endpoint = tokenEndpoint(() =>
      Response.json({ access_token: 'fake-access-2', refresh_token: 'fake-refresh-2', expires_in: 3600, scope: 'user:inference user:profile' }),
    );
    const { accounts, addSignIn, credentials } = await signInPool(endpoint.fetchImpl);
    const account = await addSignIn(signIn({ expiresAt: now.getTime() + CLAUDE_OAUTH_REFRESH_MARGIN_MS - 1 }));

    const turn = await credentials({ orgId: 'org-1', userId: 'alice' });
    expect(turn).toEqual({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'fake-access-2' }, accountId: account.id, credential: expect.any(Object) });
    expect(JSON.stringify(turn)).not.toContain('fake-refresh');
    expect(endpoint.calls).toHaveLength(1);
    expect(Object.fromEntries(endpoint.calls[0]!)).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'fake-refresh-1',
      client_id: CLAUDE_OAUTH_CLIENT_ID,
    });
    await expect(accounts.getAccountOAuth('org-1', account.id)).resolves.toMatchObject({
      accessToken: 'fake-access-2',
      refreshToken: 'fake-refresh-2',
      expiresAt: now.getTime() + 3_600_000,
      scopes: ['user:inference', 'user:profile'],
      email: 'alice@example.com',
    });
  });

  it('refreshes once when two turns race for the same expiring sign-in', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    const calls: string[] = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push(new URLSearchParams(String(init?.body)).get('refresh_token')!);
      await gate;
      return Response.json({ access_token: 'fake-access-2', refresh_token: 'fake-refresh-2', expires_in: 3600 });
    }) as typeof fetch;
    const { addSignIn, credentials } = await signInPool(fetchImpl);
    await addSignIn(signIn({ expiresAt: now.getTime() - 1 }));

    const first = credentials({ orgId: 'org-1', userId: 'alice' });
    const second = credentials({ orgId: 'org-1', userId: 'alice' });
    await new Promise(resolve => setTimeout(resolve, 20));
    release();

    const turns = await Promise.all([first, second]);
    expect(calls).toEqual(['fake-refresh-1']);
    for (const turn of turns) expect(turn).toMatchObject({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'fake-access-2' } });
  });

  it('turns a refused sign-in off with a sign-in-again message and goes on with the next account', async () => {
    const endpoint = tokenEndpoint(() => Response.json({ error: 'invalid_grant' }, { status: 400 }));
    const { accounts, addSignIn, credentials } = await signInPool(endpoint.fetchImpl);
    const expired = await addSignIn(signIn({ expiresAt: now.getTime() - 1 }));
    const next = await addSignIn(signIn({ accessToken: 'fake-access-next', refreshToken: 'fake-refresh-next', email: 'alice+2@example.com' }));
    await accounts.updateAccount('org-1', next.id, { priority: 10 });

    await expect(credentials({ orgId: 'org-1', userId: 'alice' })).resolves.toEqual({
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'fake-access-next' },
      accountId: next.id,
      credential: expect.any(Object),
    });
    expect(await accounts.getAccount('org-1', expired.id)).toMatchObject({
      disabled: true,
      lastError: expect.stringContaining('sign in to Claude again'),
    });
    // Turned off: the next turn does not ask the token endpoint again.
    await credentials({ orgId: 'org-1', userId: 'alice' });
    expect(endpoint.calls).toHaveLength(1);
  });

  it('fails the turn when the only sign-in was refused, and on a transient endpoint error keeps the account', async () => {
    const refused = await signInPool(tokenEndpoint(() => Response.json({ error: 'invalid_grant' }, { status: 401 })).fetchImpl);
    await refused.addSignIn(signIn({ expiresAt: now.getTime() - 1 }));
    await expect(refused.credentials({ orgId: 'org-1', userId: 'alice' })).rejects.toMatchObject({ kind: 'auth' });

    const flaky = await signInPool(tokenEndpoint(() => new Response('busy', { status: 503 })).fetchImpl);
    const account = await flaky.addSignIn(signIn({ expiresAt: now.getTime() - 1 }));
    await expect(flaky.credentials({ orgId: 'org-1', userId: 'alice' })).rejects.toThrow('HTTP 503');
    expect(await flaky.accounts.getAccount('org-1', account.id)).toMatchObject({ disabled: false });
  });

  it('serves only its owner’s runs', async () => {
    const endpoint = tokenEndpoint(() => Response.json({}));
    const { addSignIn, credentials } = await signInPool(endpoint.fetchImpl);
    await addSignIn(signIn());
    await expect(credentials({ orgId: 'org-1', userId: 'bob' })).rejects.toBeInstanceOf(ClaudeCodeCredentialMissingError);
  });
});

describe('Claude Code credentials: edges', () => {
  const now = new Date('2026-10-28T12:00:00Z');

  /** The storage with some methods replaced, the rest bound to it. */
  function overriding<T extends object>(target: T, overrides: Partial<Record<keyof T, unknown>>): T {
    return new Proxy(target, {
      get: (object, key) => {
        if (key in overrides) return overrides[key as keyof T];
        const value = Reflect.get(object, key, object) as unknown;
        return typeof value === 'function' ? value.bind(object) : value;
      },
    });
  }

  async function seeded() {
    const storage = await createFactoryStorageForTests();
    const accounts = storage.credentials;
    const addKey = (label: string, priority = 0) =>
      accounts.addAccount({
        orgId: 'org-1',
        provider: 'anthropic',
        label,
        kind: 'claude_login',
        ownerUserId: 'bob',
        priority,
        secret: `fake-access-${label}`,
        oauth: { accessToken: `fake-access-${label}`, refreshToken: 'fake-refresh', expiresAt: now.getTime() + 3_600_000, scopes: [] },
        createdBy: 'bob',
      });
    return { accounts, addKey };
  }

  it('goes on with the next sign-in when one vanished while it was being refreshed', async () => {
    const { accounts, addKey } = await seeded();
    const first = await addKey('first');
    const next = await addKey('next', 1);
    const vanishing = overriding(accounts, {
      refreshAccountOAuth: async (orgId: string, id: string, options: never) =>
        id === first.id ? undefined : accounts.refreshAccountOAuth(orgId, id, options),
    });
    const { credentials } = createClaudeCodeCredentials({ credentials: vanishing, now: () => now });
    await expect(credentials({ orgId: 'org-1', userId: 'bob' })).resolves.toEqual({
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'fake-access-next' },
      accountId: next.id,
      credential: expect.any(Object),
    });
  });

  it('still runs when recording the account’s use fails', async () => {
    const { accounts, addKey } = await seeded();
    const first = await addKey('first');
    const failing = overriding(accounts, { markAccountUsed: async () => Promise.reject(new Error('db down')) });
    const { credentials } = createClaudeCodeCredentials({ credentials: failing, now: () => now });
    await expect(credentials({ orgId: 'org-1', userId: 'bob' })).resolves.toMatchObject({ accountId: first.id });
  });

  it('fails without any storage, and a failure report then has nothing to update', async () => {
    const { credentials, onCredentialFailure } = createClaudeCodeCredentials({ credentials: undefined });
    await expect(credentials({ orgId: 'org-1', userId: 'bob' })).rejects.toBeInstanceOf(ClaudeCodeCredentialMissingError);
    await expect(
      onCredentialFailure({ orgId: 'org-1', userId: 'bob' }, { accountId: 'a-1', error: new ClaudeCodeError('auth', 'x') }),
    ).resolves.toBeUndefined();
  });

  it('says which account it took out of rotation, and stays quiet about failures that are not the account’s', async () => {
    const { accounts, addKey } = await seeded();
    const first = await addKey('First');
    const { onCredentialFailure } = createClaudeCodeCredentials({ credentials: accounts, now: () => now });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await onCredentialFailure({ orgId: 'org-1', userId: 'bob' }, { accountId: first.id, error: new ClaudeCodeError('failed', 'boom') });
      expect(warn).not.toHaveBeenCalled();

      const resetsAt = new Date(now.getTime() + 60_000);
      await onCredentialFailure(
        { orgId: 'org-1', userId: 'bob' },
        { accountId: first.id, error: new ClaudeCodeError('rate_limit', 'limit', { resetsAt, now }) },
      );
      expect(warn).toHaveBeenLastCalledWith('[factory] Claude account taken out of rotation', {
        orgId: 'org-1',
        accountId: first.id,
        kind: 'rate_limit',
        resetsAt: resetsAt.toISOString(),
      });
      await onCredentialFailure({ orgId: 'org-1', userId: 'bob' }, { accountId: first.id, error: new ClaudeCodeError('auth', 'bad') });
      expect(warn).toHaveBeenLastCalledWith('[factory] Claude account taken out of rotation', {
        orgId: 'org-1',
        accountId: first.id,
        kind: 'auth',
      });
    } finally {
      warn.mockRestore();
    }
  });

  it('measures a cooldown from the real clock by default', async () => {
    const { accounts, addKey } = await seeded();
    const first = await addKey('First');
    const { onCredentialFailure } = createClaudeCodeCredentials({ credentials: accounts });
    const before = Date.now();
    await onCredentialFailure({ orgId: 'org-1', userId: 'bob' }, { accountId: first.id, error: new ClaudeCodeError('rate_limit', 'limit') });
    const until = (await accounts.getAccount('org-1', first.id))!.limitedUntil!.getTime();
    expect(until).toBeGreaterThanOrEqual(before + DEFAULT_ACCOUNT_LIMIT_COOLDOWN_MS);
    expect(until).toBeLessThanOrEqual(Date.now() + DEFAULT_ACCOUNT_LIMIT_COOLDOWN_MS);
  });

  it('logs a refused sign-in by organization and account only', async () => {
    const { accounts } = await seeded();
    const signIn = await accounts.addAccount({
      orgId: 'org-1',
      provider: 'anthropic',
      label: 'alice@example.com',
      kind: 'claude_login',
      ownerUserId: 'alice',
      secret: 'fake-access-1',
      oauth: { accessToken: 'fake-access-1', refreshToken: 'fake-refresh-1', expiresAt: now.getTime() - 1, scopes: [] },
      createdBy: 'alice',
    });
    const fetchImpl = (async () => Response.json({ error: 'invalid_grant' }, { status: 400 })) as unknown as typeof fetch;
    const { credentials } = createClaudeCodeCredentials({ credentials: accounts, now: () => now, fetch: fetchImpl });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(credentials({ orgId: 'org-1', userId: 'alice' })).rejects.toMatchObject({ kind: 'auth' });
      expect(warn).toHaveBeenCalledWith('[factory] Claude sign-in refused by the token endpoint; it needs a new sign-in', {
        orgId: 'org-1',
        accountId: signIn.id,
      });
    } finally {
      warn.mockRestore();
    }
  });
});

describe('Claude Code credentials signIn', () => {
  it("hands a sign-in's fresh pair out for reading its usage, and nothing for other accounts", async () => {
    const seeded = await createFactoryStorageForTests();
    const now = new Date('2026-10-28T12:00:00Z');
    const fresh = { accessToken: 'fresh-access', refreshToken: 'r', expiresAt: now.getTime() + 24 * 3600_000, scopes: [] };
    const signIn = await seeded.credentials.addAccount({
      orgId: 'org-1',
      provider: 'anthropic',
      label: 'alice@example.com',
      kind: 'claude_login',
      ownerUserId: 'alice',
      secret: fresh.accessToken,
      oauth: fresh,
      createdBy: 'alice',
    });
    const key = await seeded.credentials.addAccount({
      orgId: 'org-1',
      provider: 'anthropic',
      label: 'Old key',
      kind: 'api_key',
      secret: 'sk-ant-api03-aaaaaaaaaaaaaaaaaaaa1111',
      createdBy: 'alice',
    });
    const credentials = createClaudeCodeCredentials({ credentials: seeded.credentials, now: () => now });
    expect((await credentials.signIn!('org-1', signIn.id))?.accessToken).toBe('fresh-access');
    expect(await credentials.signIn!('org-1', key.id)).toBeUndefined();
    expect(await credentials.signIn!('org-2', signIn.id)).toBeUndefined();
  });
});
