import { describe, expect, it } from 'vitest';

import { createFactoryStorageForTests } from '@factory/testing';

import {
  ClaudeCodeCredentialMissingError,
  claudeCodeCredentialEnv,
  createClaudeCodeCredentialsHook,
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
