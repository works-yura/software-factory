import { describe, expect, it } from 'vitest';

import { createFactoryStorageForTests } from '@factory/testing';

import { ClaudeCodeError } from '@factory/harness-claude-code';

import {
  ClaudeCodeCredentialMissingError,
  claudeCodeCredentialEnv,
  createClaudeCodeCredentials,
  createClaudeCodeCredentialsHook,
  DEFAULT_ACCOUNT_LIMIT_COOLDOWN_MS,
} from './credentials.ts';

describe('Claude Code credentials hook', () => {
  it('passes nothing in local development, so the CLI uses the person’s own login', async () => {
    const hook = createClaudeCodeCredentialsHook({ localDevelopment: true, credentials: undefined });
    await expect(hook({ orgId: 'org-1', userId: 'user-1' })).resolves.toEqual({});
  });

  it('maps the factory’s Anthropic API key and setup token to the CLI’s env', async () => {
    const seeded = await createFactoryStorageForTests();
    const hook = createClaudeCodeCredentialsHook({ localDevelopment: false, credentials: seeded.credentials });

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
    const hook = createClaudeCodeCredentialsHook({ localDevelopment: false, credentials: seeded.credentials });
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

  async function pool(options: { localDevelopment?: boolean } = {}) {
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
    const hooks = createClaudeCodeCredentials({
      localDevelopment: options.localDevelopment ?? false,
      credentials: accounts,
      now: () => now,
    });
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

  it('runs on the person’s own login in local development when no account fits them', async () => {
    const { add, credentials } = await pool({ localDevelopment: true });
    await add('Alice Max', 'subscription', aliceToken, 'alice');
    await expect(credentials({ orgId: 'org-1', userId: 'bob' })).resolves.toEqual({});
  });
});
