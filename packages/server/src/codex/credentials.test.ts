import { describe, expect, it } from 'vitest';

import { CodexError } from '@factory/harness-codex';
import { createFactoryStorageForTests } from '@factory/testing';

import { DEFAULT_ACCOUNT_LIMIT_COOLDOWN_MS } from '../accounts/pool.ts';
import { CodexCredentialMissingError, createCodexCredentials } from './credentials.ts';
import { CODEX_OAUTH_CLIENT_ID, CODEX_OAUTH_TOKEN_URL, codexSignInIdentity, parseCodexAuthJson } from './oauth.ts';

const now = new Date('2026-11-11T12:00:00Z');
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
/** A ChatGPT access token as Codex gets it: a JWT whose claims carry its expiry, plan and workspace. */
const jwt = (claims: Record<string, unknown>) => `${b64({ alg: 'none' })}.${b64(claims)}.sig`;
const accessToken = (name: string, expiresInMs: number) =>
  jwt({
    exp: Math.floor((now.getTime() + expiresInMs) / 1000),
    name,
    'https://api.openai.com/auth': { chatgpt_plan_type: 'plus', chatgpt_account_id: `ws-${name}`, chatgpt_user_id: `user-${name}` },
  });

async function seeded() {
  const storage = await createFactoryStorageForTests();
  const accounts = storage.credentials;
  const add = (label: string, ownerUserId: string, { expiresInMs = 3_600_000, priority = 0 } = {}) => {
    const token = accessToken(label, expiresInMs);
    return accounts.addAccount({
      orgId: 'org-1',
      provider: 'openai-codex',
      label,
      kind: 'codex_login',
      ownerUserId,
      priority,
      secret: token,
      oauth: { accessToken: token, refreshToken: `refresh-${label}`, expiresAt: now.getTime() + expiresInMs, scopes: [], workspaceId: `ws-${label}`, subscriptionType: 'plus' },
      createdBy: ownerUserId,
    });
  };
  return { accounts, add };
}

describe('Codex credentials', () => {
  it('never runs without a ChatGPT sign-in: no own `codex login`, no OpenAI key, no Claude sign-in', async () => {
    const { accounts } = await seeded();
    await accounts.setCredential({ orgId: 'org-1' }, 'openai', { type: 'api_key', key: 'sk-proj-x' });
    await accounts.addAccount({
      orgId: 'org-1',
      provider: 'anthropic',
      label: 'claude',
      kind: 'claude_login',
      ownerUserId: 'alice',
      secret: 'x',
      oauth: { accessToken: 'x', refreshToken: 'y', expiresAt: now.getTime() + 3_600_000, scopes: [] },
      createdBy: 'alice',
    });
    const codex = createCodexCredentials({ credentials: accounts, now: () => now });
    await expect(codex.credentials({ orgId: 'org-1', userId: 'alice' })).rejects.toBeInstanceOf(CodexCredentialMissingError);
    await expect(codex.credentials({ orgId: 'org-1', userId: 'alice' })).rejects.toThrow('Settings → Connections → Codex');
    expect(await codex.usable({ orgId: 'org-1', userId: 'alice' })).toBe(false);
  });

  it('gives a run its owner’s access token and workspace alone, and names the account', async () => {
    const { accounts, add } = await seeded();
    const alice = await add('alice', 'alice');
    const codex = createCodexCredentials({ credentials: accounts, now: () => now });
    await expect(codex.credentials({ orgId: 'org-1', userId: 'alice' })).resolves.toEqual({
      tokens: { accessToken: accessToken('alice', 3_600_000), chatgptAccountId: 'ws-alice', planType: 'plus' },
      accountId: alice.id,
      credential: { label: 'alice', ownerId: 'alice' },
    });
    expect(await codex.usable({ orgId: 'org-1', userId: 'alice' })).toBe(true);
    // Another member's sign-in serves only its owner.
    expect(await codex.usable({ orgId: 'org-1', userId: 'bob' })).toBe(false);
  });

  it('refreshes a due sign-in under the row lock before the run, and keeps the rotated refresh token', async () => {
    const { accounts, add } = await seeded();
    const alice = await add('alice', 'alice', { expiresInMs: 60_000 });
    const fresh = accessToken('alice-2', 10 * 24 * 3_600_000);
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ access_token: fresh, refresh_token: 'refresh-2' }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const codex = createCodexCredentials({ credentials: accounts, now: () => now, fetch });
    const picked = await codex.credentials({ orgId: 'org-1', userId: 'alice' });
    expect(picked.tokens.accessToken).toBe(fresh);
    expect(picked.tokens.chatgptAccountId).toBe('ws-alice-2');
    expect(calls).toEqual([
      {
        url: CODEX_OAUTH_TOKEN_URL,
        body: { client_id: CODEX_OAUTH_CLIENT_ID, grant_type: 'refresh_token', refresh_token: 'refresh-alice', scope: 'openid profile email' },
      },
    ]);
    expect(await accounts.getAccountOAuth('org-1', alice.id)).toMatchObject({ accessToken: fresh, refreshToken: 'refresh-2' });
    // Fresh now: the next run does not refresh again.
    await codex.credentials({ orgId: 'org-1', userId: 'alice' });
    expect(calls).toHaveLength(1);
  });

  it('refreshes a token the backend refused mid-run once, even when several runs ask', async () => {
    const { accounts, add } = await seeded();
    const alice = await add('alice', 'alice');
    const stale = accessToken('alice', 3_600_000);
    let refreshes = 0;
    const fetch = (async () => {
      refreshes += 1;
      return new Response(JSON.stringify({ access_token: accessToken('alice-2', 3_600_000), refresh_token: 'refresh-2' }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const codex = createCodexCredentials({ credentials: accounts, now: () => now, fetch });
    const tenant = { orgId: 'org-1', userId: 'alice' };
    const first = await codex.refresh(tenant, { accountId: alice.id, accessToken: stale });
    const second = await codex.refresh(tenant, { accountId: alice.id, accessToken: stale });
    expect(first?.accessToken).toBe(accessToken('alice-2', 3_600_000));
    expect(second).toEqual(first);
    expect(refreshes).toBe(1);
  });

  it('turns off a sign-in the token endpoint refuses and goes on with the next one', async () => {
    const { accounts, add } = await seeded();
    const gone = await add('gone', 'alice', { expiresInMs: 0 });
    const next = await add('next', 'alice', { priority: 1 });
    const fetch = (async () => new Response(JSON.stringify({ error: { code: 'refresh_token_reused' } }), { status: 401 })) as unknown as typeof globalThis.fetch;
    const codex = createCodexCredentials({ credentials: accounts, now: () => now, fetch });
    await expect(codex.credentials({ orgId: 'org-1', userId: 'alice' })).resolves.toMatchObject({ accountId: next.id });
    const off = await accounts.getAccount('org-1', gone.id);
    expect(off).toMatchObject({ disabled: true });
    expect(off?.lastError).toContain('refresh_token_reused');
  });

  it('sets an account out of usage aside until its reset, and says when the first comes back', async () => {
    const { accounts, add } = await seeded();
    const first = await add('first', 'alice');
    const codex = createCodexCredentials({ credentials: accounts, now: () => now });
    const tenant = { orgId: 'org-1', userId: 'alice' };
    const resetsAt = new Date(now.getTime() + 2 * 3_600_000);
    await codex.onCredentialFailure(tenant, { accountId: first.id, error: new CodexError('rate_limit', 'usage limit', { resetsAt }) });
    expect((await accounts.getAccount('org-1', first.id))?.limitedUntil).toEqual(resetsAt);
    const failure = codex.credentials(tenant, { exclude: [first.id] });
    await expect(failure).rejects.toMatchObject({ kind: 'rate_limit', resetsAt });
    // Limited, not gone: Codex stays available, and the cooldown without a reset time is the default one.
    expect(await codex.usable(tenant)).toBe(true);
    const second = await add('second', 'alice');
    await codex.onCredentialFailure(tenant, { accountId: second.id, error: new CodexError('rate_limit', 'usage limit') });
    expect((await accounts.getAccount('org-1', second.id))?.limitedUntil).toEqual(new Date(now.getTime() + DEFAULT_ACCOUNT_LIMIT_COOLDOWN_MS));
    await codex.onCredentialFailure(tenant, { accountId: second.id, error: new CodexError('auth', 'refused') });
    expect((await accounts.getAccount('org-1', second.id))?.disabled).toBe(true);
  });
});

describe('Codex sign-in tokens', () => {
  it('reads who signed in from a `codex login` home’s auth.json', () => {
    const idToken = jwt({ email: 'alice@example.com', sub: 'auth0|1', 'https://api.openai.com/auth': { chatgpt_plan_type: 'pro', chatgpt_account_id: 'ws-1', chatgpt_user_id: 'user-1' } });
    const access = accessToken('a', 3_600_000);
    const oauth = parseCodexAuthJson(
      JSON.stringify({ OPENAI_API_KEY: null, tokens: { id_token: idToken, access_token: access, refresh_token: 'r', account_id: 'ws-1' }, last_refresh: now.toISOString() }),
    );
    expect(oauth).toMatchObject({
      accessToken: access,
      refreshToken: 'r',
      idToken,
      email: 'alice@example.com',
      workspaceId: 'ws-1',
      subscriptionType: 'pro',
      accountUuid: 'user-1:ws-1',
      expiresAt: Math.floor((now.getTime() + 3_600_000) / 1000) * 1000,
    });
    expect(parseCodexAuthJson(JSON.stringify({ OPENAI_API_KEY: 'sk-x', tokens: null }))).toBeUndefined();
    expect(parseCodexAuthJson('not json')).toBeUndefined();
    expect(codexSignInIdentity({ accessToken: 'opaque' })).toEqual({ expiresAt: 0 });
  });
});
