import { describe, expect, it, vi } from 'vitest';

import { createFactoryStorageForTests } from '@factory/testing';
import type { ClaudeLoginOAuth } from '@factory/store';

import { ClaudeCodeError } from '@factory/harness-claude-code';

import {
  ClaudeCodeCredentialMissingError,
  claudeCodeCredentialEnv,
  createClaudeCodeCredentials,
  createClaudeCodeCredentialsHook,
  DEFAULT_ACCOUNT_LIMIT_COOLDOWN_MS,
} from './credentials.ts';
import { CLAUDE_OAUTH_CLIENT_ID, CLAUDE_OAUTH_REFRESH_MARGIN_MS, CLAUDE_OAUTH_TOKEN_URL } from './oauth.ts';

describe('Claude Code credentials hook', () => {
  it('never falls back to the person’s own claude login: with nothing stored it asks for a sign-in', async () => {
    const hook = createClaudeCodeCredentialsHook({ credentials: undefined });
    const failure = hook({ orgId: 'org-1', userId: 'user-1' });
    await expect(failure).rejects.toBeInstanceOf(ClaudeCodeCredentialMissingError);
    await expect(failure).rejects.toThrow(
      'No Claude account is set for organization org-1. Sign in to Claude, or add an Anthropic API key or a Claude setup token, under Settings → Models → Claude Code accounts to run Claude Code sessions.',
    );
  });

  it('maps the factory’s Anthropic API key and setup token to the CLI’s env', async () => {
    const seeded = await createFactoryStorageForTests();
    const hook = createClaudeCodeCredentialsHook({ credentials: seeded.credentials });

    await seeded.credentials.setCredential({ orgId: 'org-1' }, 'anthropic', { type: 'api_key', key: 'sk-ant-api03-x' });
    await expect(hook({ orgId: 'org-1', userId: 'user-1' })).resolves.toEqual({ ANTHROPIC_API_KEY: 'sk-ant-api03-x' });

    await seeded.credentials.setCredential({ orgId: 'org-2' }, 'anthropic', { type: 'api_key', key: 'sk-ant-oat01-y' });
    await expect(hook({ orgId: 'org-2', userId: 'user-1' })).resolves.toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-y',
    });
  });

  it('never uses a person’s own credential for a factory run, and says what is missing', async () => {
    const seeded = await createFactoryStorageForTests();
    await seeded.credentials.setCredential({ orgId: 'org-1', userId: 'user-1' }, 'anthropic', {
      type: 'api_key',
      key: 'sk-ant-api03-personal',
    });
    const hook = createClaudeCodeCredentialsHook({ credentials: seeded.credentials });
    await expect(hook({ orgId: 'org-1', userId: 'user-1' })).rejects.toBeInstanceOf(ClaudeCodeCredentialMissingError);
  });

  it('sends OAuth access tokens as CLAUDE_CODE_OAUTH_TOKEN', () => {
    expect(claudeCodeCredentialEnv({ type: 'oauth', secret: 'access-1' })).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: 'access-1',
    });
  });
});

describe('Claude Code credential accounts', () => {
  const now = new Date('2026-10-28T12:00:00Z');
  const apiKey = 'sk-ant-api03-aaaaaaaaaaaaaaaaaaaa1111';
  const aliceToken = 'sk-ant-oat01-bbbbbbbbbbbbbbbbbbbb2222';

  async function pool() {
    const seeded = await createFactoryStorageForTests();
    const accounts = seeded.credentials;
    const add = (label: string, kind: 'api_key' | 'subscription', secret: string, ownerUserId?: string) =>
      accounts.addAccount({
        orgId: 'org-1',
        provider: 'anthropic',
        label,
        kind,
        secret,
        createdBy: ownerUserId ?? 'admin',
        ...(ownerUserId ? { ownerUserId } : {}),
      });
    const hooks = createClaudeCodeCredentials({ credentials: accounts, now: () => now });
    return { accounts, add, ...hooks };
  }

  it('gives a run its owner’s subscription first and names the account', async () => {
    const { add, credentials, accounts } = await pool();
    await add('Team key', 'api_key', apiKey);
    const alice = await add('Alice Max', 'subscription', aliceToken, 'alice');

    await expect(credentials({ orgId: 'org-1', userId: 'alice' }, { exclude: [] })).resolves.toEqual({
      env: { CLAUDE_CODE_OAUTH_TOKEN: aliceToken },
      accountId: alice.id,
    });
    expect((await accounts.getAccount('org-1', alice.id))?.lastUsedAt).toEqual(now);
    // Bob never gets Alice's subscription.
    await expect(credentials({ orgId: 'org-1', userId: 'bob' }, { exclude: [] })).resolves.toMatchObject({
      env: { ANTHROPIC_API_KEY: apiKey },
    });
  });

  it('sets an account aside until its reset and moves to the next', async () => {
    const { add, credentials, onCredentialFailure, accounts } = await pool();
    const first = await add('First', 'api_key', apiKey);
    const second = await add('Second', 'api_key', 'sk-ant-api03-cccccccccccccccccccc3333');
    const resetsAt = new Date(now.getTime() + 2 * 3_600_000);

    await onCredentialFailure(
      { orgId: 'org-1', userId: 'bob' },
      { accountId: first.id, error: new ClaudeCodeError('rate_limit', 'limit', { resetsAt, now }) },
    );
    expect((await accounts.getAccount('org-1', first.id))?.limitedUntil).toEqual(resetsAt);
    await expect(credentials({ orgId: 'org-1', userId: 'bob' }, { exclude: [first.id] })).resolves.toMatchObject({
      accountId: second.id,
    });
    // A later turn of another session also skips it while it is limited.
    await expect(credentials({ orgId: 'org-1', userId: 'bob' }, { exclude: [] })).resolves.toMatchObject({
      accountId: second.id,
    });
  });

  it('sits an account out for the default cooldown when no reset was given', async () => {
    const { add, onCredentialFailure, accounts } = await pool();
    const first = await add('First', 'api_key', apiKey);
    await onCredentialFailure(
      { orgId: 'org-1', userId: 'bob' },
      { accountId: first.id, error: new ClaudeCodeError('rate_limit', 'limit') },
    );
    expect((await accounts.getAccount('org-1', first.id))?.limitedUntil).toEqual(
      new Date(now.getTime() + DEFAULT_ACCOUNT_LIMIT_COOLDOWN_MS),
    );
  });

  it('turns off a refused account and ignores failures that are not the account’s', async () => {
    const { add, onCredentialFailure, accounts } = await pool();
    const first = await add('First', 'api_key', apiKey);
    await onCredentialFailure(
      { orgId: 'org-1', userId: 'bob' },
      { accountId: first.id, error: new ClaudeCodeError('failed', 'boom') },
    );
    expect((await accounts.getAccount('org-1', first.id))?.disabled).toBe(false);
    await onCredentialFailure(
      { orgId: 'org-1', userId: 'bob' },
      { accountId: first.id, error: new ClaudeCodeError('auth', 'Invalid API key') },
    );
    expect(await accounts.getAccount('org-1', first.id)).toMatchObject({ disabled: true, lastError: 'Invalid API key' });
  });

  it('fails with the earliest reset when every account is out of usage', async () => {
    const { add, credentials, onCredentialFailure } = await pool();
    const first = await add('First', 'api_key', apiKey);
    const resetsAt = new Date(now.getTime() + 3_600_000);
    await onCredentialFailure(
      { orgId: 'org-1', userId: 'bob' },
      { accountId: first.id, error: new ClaudeCodeError('rate_limit', 'limit', { resetsAt, now }) },
    );

    const error = await credentials({ orgId: 'org-1', userId: 'bob' }, { exclude: [first.id] }).catch(e => e);
    expect(error).toBeInstanceOf(ClaudeCodeError);
    expect(error).toMatchObject({ kind: 'rate_limit', resetsAt });
  });

  it('does not fall back to the single credential once an account failed this turn', async () => {
    const { add, credentials, onCredentialFailure, accounts } = await pool();
    await accounts.setCredential({ orgId: 'org-1' }, 'anthropic', { type: 'api_key', key: 'sk-ant-api03-legacy' });
    const first = await add('First', 'api_key', apiKey);
    await onCredentialFailure(
      { orgId: 'org-1', userId: 'bob' },
      { accountId: first.id, error: new ClaudeCodeError('auth', 'Invalid API key') },
    );

    await expect(credentials({ orgId: 'org-1', userId: 'bob' }, { exclude: [first.id] })).rejects.toMatchObject({
      kind: 'auth',
    });
    // A new turn with nothing tried uses the organization's single credential again.
    await expect(credentials({ orgId: 'org-1', userId: 'bob' }, { exclude: [] })).resolves.toEqual({
      ANTHROPIC_API_KEY: 'sk-ant-api03-legacy',
    });
  });

  it('asks for a sign-in rather than the person’s own login when no account fits them', async () => {
    const { add, credentials } = await pool();
    await add('Alice Max', 'subscription', aliceToken, 'alice');
    await expect(credentials({ orgId: 'org-1', userId: 'bob' })).rejects.toBeInstanceOf(ClaudeCodeCredentialMissingError);
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
    expect(turn).toEqual({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'fake-access-2' }, accountId: account.id });
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
    const key = await accounts.addAccount({
      orgId: 'org-1',
      provider: 'anthropic',
      label: 'Team key',
      kind: 'api_key',
      secret: 'sk-ant-api03-aaaaaaaaaaaaaaaaaaaa1111',
      createdBy: 'admin',
    });

    await expect(credentials({ orgId: 'org-1', userId: 'alice' })).resolves.toEqual({
      env: { ANTHROPIC_API_KEY: 'sk-ant-api03-aaaaaaaaaaaaaaaaaaaa1111' },
      accountId: key.id,
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
  const apiKey = 'sk-ant-api03-aaaaaaaaaaaaaaaaaaaa1111';

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
    const addKey = (label: string, secret = apiKey) =>
      accounts.addAccount({ orgId: 'org-1', provider: 'anthropic', label, kind: 'api_key', secret, createdBy: 'admin' });
    return { accounts, addKey };
  }

  it('gives a run the account it asked for by id', async () => {
    const { accounts, addKey } = await seeded();
    await addKey('First');
    const second = await addKey('Second', 'sk-ant-api03-dddddddddddddddddddd4444');
    const { credentials } = createClaudeCodeCredentials({ credentials: accounts, now: () => now });
    await expect(
      credentials({ orgId: 'org-1', userId: 'bob' }, { exclude: [], preferredAccountId: second.id }),
    ).resolves.toEqual({ env: { ANTHROPIC_API_KEY: 'sk-ant-api03-dddddddddddddddddddd4444' }, accountId: second.id });
  });

  it('goes on with the next account when a sign-in vanished while it was being refreshed', async () => {
    const { accounts, addKey } = await seeded();
    await accounts.addAccount({
      orgId: 'org-1',
      provider: 'anthropic',
      label: 'alice@example.com',
      kind: 'claude_login',
      ownerUserId: 'alice',
      secret: 'fake-access-1',
      oauth: { accessToken: 'fake-access-1', refreshToken: 'fake-refresh-1', expiresAt: now.getTime() + 3_600_000, scopes: [] },
      createdBy: 'alice',
    });
    const key = await addKey('Team key');
    const vanishing = overriding(accounts, { refreshAccountOAuth: async () => undefined });
    const { credentials } = createClaudeCodeCredentials({ credentials: vanishing, now: () => now });
    await expect(credentials({ orgId: 'org-1', userId: 'alice' })).resolves.toEqual({
      env: { ANTHROPIC_API_KEY: apiKey },
      accountId: key.id,
    });
  });

  it('fails the turn when an account’s secret is gone between listing it and reading it', async () => {
    const { accounts, addKey } = await seeded();
    await addKey('Team key');
    const gone = overriding(accounts, { getAccountSecret: async () => undefined });
    const { credentials } = createClaudeCodeCredentials({ credentials: gone, now: () => now });
    await expect(credentials({ orgId: 'org-1', userId: 'bob' })).rejects.toMatchObject({
      kind: 'auth',
      message: 'Claude account Team key is no longer available.',
    });
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
