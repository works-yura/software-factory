/**
 * The assistant's models: the organization's catalog as Factory groups it (Mastra's providers, then
 * each harness's sign-ins), what runs now for whom, the default and why, and harness models run on
 * the sign-in pools with fake models (no real tokens) — moving to the next account on a 429.
 */
import { AssistantTurnError, classifyTurnFailure } from '@factory/assistant-core';
import type { ModelCatalogEntry } from '@factory/credentials';
import { claudeCodeCatalogDefault, claudeCodeModels } from '@factory/harness-claude-code';
import type { ServerProviderModel } from '@factory/harness/models/contracts';
import type { HarnessModels } from '@factory/harness/models/facet';
import type { CredentialRecord } from '@factory/store';
import { createFactoryStorageForTests } from '@factory/testing';
import { describe, expect, it, vi } from 'vitest';

import {
  buildAssistantModelCatalog,
  createAssistantHarnessRunners,
  createClaudeSignInRunner,
  createCodexSignInRunner,
  resolveHarnessTurnModel,
  signInCredentialStore,
} from './models.ts';
import type { AssistantModelCatalogDeps } from './models.ts';
import { rateLimitOf } from './pooled-model.ts';

const NOW = new Date('2026-11-15T12:00:00Z');
const now = () => NOW;
const ADA = { orgId: 'org-1', userId: 'ada' };
const BOB = { orgId: 'org-1', userId: 'bob' };

function facet(
  instanceId: string,
  displayName: string,
  models: ServerProviderModel[] | Error,
  catalogDefault: string | null = null,
): HarnessModels {
  return {
    instanceId,
    harnessId: instanceId,
    displayName,
    list: async () => {
      if (models instanceof Error) throw models;
      return models;
    },
    catalogDefault: async () => (catalogDefault ? { instanceId, model: catalogDefault } : null),
  } as unknown as HarnessModels;
}

const model = (slug: string, name: string, extra: Partial<ServerProviderModel> = {}): ServerProviderModel => ({
  slug,
  name,
  isCustom: false,
  capabilities: null,
  ...extra,
});

function mastraEntry(id: string, credentialLabel?: string): ModelCatalogEntry {
  const [provider, modelName] = id.split('/') as [string, string];
  return { id, provider, modelName, hasApiKey: true, credentialHolder: 'organization', ...(credentialLabel ? { credentialLabel } : {}) };
}

const apiKey = (provider: string): CredentialRecord => ({
  provider,
  scope: 'org',
  credential: { type: 'api_key', key: 'not-a-real-key' },
  updatedAt: NOW,
});

async function seeded() {
  const seed = await createFactoryStorageForTests();
  const accounts = seed.credentials;
  const signIn = (provider: string, kind: 'claude_login' | 'codex_login', label: string, owner: string, priority = 0, workspaceId?: string) =>
    accounts.addAccount({
      orgId: 'org-1',
      provider,
      label,
      kind,
      ownerUserId: owner,
      priority,
      secret: `fake-access-${label}`,
      oauth: {
        accessToken: `fake-access-${label}`,
        refreshToken: `fake-refresh-${label}`,
        expiresAt: NOW.getTime() + 3_600_000,
        scopes: [],
        ...(workspaceId ? { workspaceId } : {}),
      },
      createdBy: owner,
    });
  return { accounts, signIn };
}

function harnesses(): HarnessModels[] {
  return [
    facet('claude-code', 'Claude Code', claudeCodeModels(), claudeCodeCatalogDefault()?.model ?? null),
    facet('codex', 'Codex', [model('gpt-5.5', 'GPT-5.5', { isDefault: true })], 'gpt-5.5'),
    facet('opencode', 'OpenCode', [model('opencode/big-pickle', 'Big Pickle', { badge: 'free', isDefault: true })], 'opencode/big-pickle'),
    facet('cursor', 'Cursor', [model('auto', 'Auto')]),
  ];
}

function deps(
  credentials: Awaited<ReturnType<typeof seeded>>['accounts'],
  input: { mastra?: ModelCatalogEntry[]; records?: CredentialRecord[]; chatDefault?: string; harnesses?: HarnessModels[] } = {},
): AssistantModelCatalogDeps {
  return {
    mastra: async () => ({ models: input.mastra ?? [], credentials: input.records ?? [] }),
    factoryChatDefault: async () => input.chatDefault,
    harnesses: () => input.harnesses ?? harnesses(),
    runners: createAssistantHarnessRunners({ credentials, now }),
  };
}

describe('the assistant’s model catalog', () => {
  it('groups the organization’s models as Factory does, with what runs now for this person', async () => {
    const { accounts, signIn } = await seeded();
    await signIn('anthropic', 'claude_login', 'ada@example.com', 'ada');
    const codex = await signIn('openai-codex', 'codex_login', 'ada-chatgpt', 'ada', 0, 'ws-1');
    await accounts.markAccountLimited('org-1', codex.id, { until: new Date(NOW.getTime() + 3_600_000), error: 'usage limit' });

    const catalog = await buildAssistantModelCatalog(
      deps(accounts, {
        mastra: [mastraEntry('opencode/big-pickle', 'OpenCode API key'), mastraEntry('xai/grok-4', 'xAI API key')],
        records: [apiKey('opencode'), apiKey('xai')],
        chatDefault: 'xai/grok-4',
      }),
      ADA,
    );

    expect(catalog.groups.map(group => [group.id, group.credential, group.availability.state])).toEqual([
      ['mastra/opencode', 'api_key', 'ready'],
      ['mastra/xai', 'api_key', 'ready'],
      ['claude-code', 'claude_login', 'ready'],
      ['codex', 'codex_login', 'limited'],
      ['opencode', 'opencode_account', 'no_credentials'],
      ['cursor', 'cli_only', 'sessions_only'],
    ]);
    const byId = Object.fromEntries(catalog.groups.map(group => [group.id, group]));
    expect(byId['mastra/opencode']!.models[0]).toMatchObject({ id: 'opencode/big-pickle', free: true, selectable: true });
    expect(byId['claude-code']).toMatchObject({ label: 'Claude Code · Claude sign-in', provider: 'anthropic', credentialLabel: 'ada@example.com' });
    expect(byId['claude-code']!.models[0]).toMatchObject({
      id: 'claude-code:claude-opus-5-5',
      label: 'Claude Opus 5.5',
      provider: 'anthropic',
      selectable: true,
      availability: { state: 'ready' },
    });
    expect(byId['claude-code']!.models.find(entry => entry.legacy)).toBeDefined();
    // Out of usage: still pickable, with when it comes back.
    expect(byId.codex!.availability).toMatchObject({ state: 'limited', until: '2026-11-15T13:00:00.000Z', connector: 'codex' });
    expect(byId.codex!.models[0]).toMatchObject({ id: 'codex:gpt-5.5', selectable: true });
    // Keyless free OpenCode models run only in the CLI: listed, not pickable, and why.
    expect(byId.opencode!.models[0]).toMatchObject({
      id: 'opencode:opencode/big-pickle',
      free: true,
      selectable: false,
      availability: { state: 'sessions_only', reason: expect.stringMatching(/only inside the opencode CLI/) },
    });
    expect(byId.cursor!.models[0]).toMatchObject({ selectable: false, availability: { state: 'sessions_only' } });
    expect(catalog.default).toMatchObject({ modelId: 'xai/grok-4', source: 'factory_default' });
  });

  it('never offers another member’s sign-in: it says whose they are and where to connect one', async () => {
    const { accounts, signIn } = await seeded();
    await signIn('anthropic', 'claude_login', 'ada@example.com', 'ada');
    const catalog = await buildAssistantModelCatalog(deps(accounts), BOB);
    const claude = catalog.groups.find(group => group.id === 'claude-code')!;
    expect(claude.availability).toMatchObject({ state: 'no_credentials', connector: 'claude-code', reason: expect.stringMatching(/belong to other members/) });
    expect(claude.models.every(entry => !entry.selectable)).toBe(true);
    expect(catalog.default).toBeNull();
    expect(catalog.defaultReason).toMatch(/no other model is ready/);
  });

  it('lists a harness whose catalog cannot be read as unavailable, with why', async () => {
    const { accounts, signIn } = await seeded();
    await signIn('openai-codex', 'codex_login', 'ada-chatgpt', 'ada', 0, 'ws-1');
    const catalog = await buildAssistantModelCatalog(
      deps(accounts, { harnesses: [facet('codex', 'Codex', new Error('The codex CLI is not installed on this server.'))] }),
      ADA,
    );
    expect(catalog.groups).toEqual([
      expect.objectContaining({ id: 'codex', availability: expect.objectContaining({ state: 'unavailable', reason: 'The codex CLI is not installed on this server.' }), models: [] }),
    ]);
  });
});

describe('the assistant’s default model', () => {
  it('is the new Factory chat’s default when it runs, else the first runnable model in the organization’s order, with why', async () => {
    const { accounts, signIn } = await seeded();
    await signIn('anthropic', 'claude_login', 'ada@example.com', 'ada');

    const unrunnable = await buildAssistantModelCatalog(deps(accounts, { chatDefault: 'anthropic/claude-opus-5-5' }), ADA);
    expect(unrunnable.default).toMatchObject({ modelId: 'claude-code:claude-opus-5-5', source: 'org_preference' });
    expect(unrunnable.default!.reason).toMatch(/anthropic\/claude-opus-5-5, which this organization has no credential for/);

    // Mastra's own preference order (`PROVIDER_DEFAULT_MODELS`) goes before the harnesses' defaults.
    const { PROVIDER_DEFAULT_MODELS } = await import('@mastra/code-sdk/auth/storage');
    const [provider, preferred] = Object.entries(PROVIDER_DEFAULT_MODELS)[0]!;
    const withKey = await buildAssistantModelCatalog(
      deps(accounts, { mastra: [mastraEntry(preferred)], records: [apiKey(provider)], chatDefault: undefined }),
      ADA,
    );
    expect(withKey.default).toMatchObject({ modelId: preferred, source: 'org_preference' });
    expect(withKey.default!.reason).toMatch(/Factory names no built-in default/);
  });

  it('skips a default whose accounts are all out of usage', async () => {
    const { accounts, signIn } = await seeded();
    const claude = await signIn('anthropic', 'claude_login', 'ada@example.com', 'ada');
    await accounts.markAccountLimited('org-1', claude.id, { until: new Date(NOW.getTime() + 60_000), error: 'usage' });
    await signIn('openai-codex', 'codex_login', 'ada-chatgpt', 'ada', 0, 'ws-1');
    const catalog = await buildAssistantModelCatalog(deps(accounts, { chatDefault: 'claude-code:claude-opus-5-5' }), ADA);
    expect(catalog.default).toMatchObject({ modelId: 'codex:gpt-5.5', source: 'org_preference' });
    expect(catalog.default!.reason).toMatch(/cannot run now/);
  });
});

function fakeModel(answer: (token: string) => Promise<unknown>, token: string) {
  return { specificationVersion: 'v2', provider: 'fake', modelId: 'fake', supportedUrls: {}, doGenerate: vi.fn(() => answer(token)), doStream: vi.fn() };
}

const limited = (seconds?: number) =>
  Object.assign(new Error('rate_limit_error: usage limit reached'), {
    statusCode: 429,
    responseHeaders: seconds === undefined ? {} : { 'retry-after': String(seconds) },
  });

describe('harness models in the assistant', () => {
  it('runs a Claude Code model on the person’s Claude sign-in through the API (the alias compiled to its API id)', async () => {
    const { accounts, signIn } = await seeded();
    await signIn('anthropic', 'claude_login', 'ada@example.com', 'ada');
    const build = vi.fn((apiModelId: string, token: string) => fakeModel(async () => ({ text: `${apiModelId} on ${token}` }), token));
    const runner = createClaudeSignInRunner({ credentials: accounts, now, build });
    const resolved = (await runner.model(ADA, 'opus')) as ReturnType<typeof fakeModel>;
    await expect(resolved.doGenerate()).resolves.toEqual({ text: 'claude-opus-5-5 on fake-access-ada@example.com' });
    expect(build).toHaveBeenCalledWith('claude-opus-5-5', 'fake-access-ada@example.com');
  });

  it('runs a Codex model on the person’s ChatGPT sign-in with its workspace', async () => {
    const { accounts, signIn } = await seeded();
    await signIn('openai-codex', 'codex_login', 'ada-chatgpt', 'ada', 0, 'ws-1');
    const build = vi.fn((slug: string, tokens: { accessToken: string; chatgptAccountId: string }) => fakeModel(async () => ({ slug, tokens }), tokens.accessToken));
    const runner = createCodexSignInRunner({ credentials: accounts, now, build });
    const resolved = (await runner.model(ADA, 'gpt-5.5')) as ReturnType<typeof fakeModel>;
    await expect(resolved.doGenerate()).resolves.toEqual({ slug: 'gpt-5.5', tokens: { accessToken: 'fake-access-ada-chatgpt', chatgptAccountId: 'ws-1' } });
  });

  it('hands Mastra’s OAuth providers the sign-in alone, as a credential store with no environment fallback', async () => {
    const store = signInCredentialStore('openai-codex', { access: 'fake-token', accountId: 'ws-1' });
    expect(store.allowEnvironmentFallback).toBe(false);
    expect(store.get('openai-codex')).toMatchObject({ type: 'oauth', access: 'fake-token', accountId: 'ws-1' });
    await expect(store.getOAuthCredential!('openai-codex')).resolves.toMatchObject({ access: 'fake-token', accountId: 'ws-1' });
    await expect(store.getApiKey('openai-codex')).resolves.toBe('fake-token');
    expect(store.get('anthropic')).toBeUndefined();
  });

  it('moves to the next sign-in on a 429, parking the limited one until the provider says it resets', async () => {
    const { accounts, signIn } = await seeded();
    const first = await signIn('anthropic', 'claude_login', 'first', 'ada', 0);
    await signIn('anthropic', 'claude_login', 'second', 'ada', 1);
    const answers: Record<string, () => Promise<unknown>> = {
      'fake-access-first': async () => {
        throw limited(600);
      },
      'fake-access-second': async () => ({ text: 'answered on second' }),
    };
    const runner = createClaudeSignInRunner({ credentials: accounts, now, build: (_id, token) => fakeModel(() => answers[token]!(), token) });
    const resolved = (await runner.model(ADA, 'claude-sonnet-5-5')) as ReturnType<typeof fakeModel>;
    await expect(resolved.doGenerate()).resolves.toEqual({ text: 'answered on second' });
    const parked = await accounts.getAccount('org-1', first.id);
    expect(parked?.limitedUntil?.toISOString()).toBe('2026-11-15T12:10:00.000Z');

    // The next turn starts on the second; when it runs out too, the turn says when the first comes back.
    answers['fake-access-second'] = async () => {
      throw limited(1200);
    };
    const next = (await runner.model(ADA, 'claude-sonnet-5-5')) as ReturnType<typeof fakeModel>;
    const failure = await next.doGenerate().catch(error => error);
    expect(failure).toMatchObject({ statusCode: 429, message: expect.stringMatching(/first comes back at 2026-11-15T12:10:00/) });
    expect(classifyTurnFailure(new AssistantTurnError('claude-code:claude-sonnet-5-5', failure))).toMatchObject({
      kind: 'rate_limit',
      modelId: 'claude-code:claude-sonnet-5-5',
      status: 429,
    });
  });

  it('does not park an account on a 429 that names no reset: it only skips it for this turn', async () => {
    const { accounts, signIn } = await seeded();
    const first = await signIn('anthropic', 'claude_login', 'first', 'ada', 0);
    await signIn('anthropic', 'claude_login', 'second', 'ada', 1);
    const runner = createClaudeSignInRunner({
      credentials: accounts,
      now,
      build: (_id, token) =>
        fakeModel(async () => {
          if (token === 'fake-access-first') throw limited();
          return { text: 'ok' };
        }, token),
    });
    const resolved = (await runner.model(ADA, 'claude-sonnet-5-5')) as ReturnType<typeof fakeModel>;
    await expect(resolved.doGenerate()).resolves.toEqual({ text: 'ok' });
    expect((await accounts.getAccount('org-1', first.id))?.limitedUntil).toBeUndefined();
  });

  it('refuses loudly, naming the model, when it cannot run here', async () => {
    const { accounts, signIn } = await seeded();
    await signIn('anthropic', 'claude_login', 'ada@example.com', 'ada');
    const turnDeps = deps(accounts);
    const cliOnly = await resolveHarnessTurnModel(turnDeps, ADA, 'cursor:auto').catch(error => error);
    expect(classifyTurnFailure(cliOnly)).toMatchObject({ kind: 'model_not_found', modelId: 'cursor:auto', detail: expect.stringMatching(/only through its CLI/) });
    const noSignIn = await resolveHarnessTurnModel(turnDeps, BOB, 'claude-code:claude-opus-5-5').catch(error => error);
    expect(classifyTurnFailure(noSignIn)).toMatchObject({ kind: 'auth', modelId: 'claude-code:claude-opus-5-5', detail: expect.stringMatching(/No Claude sign-in of yours/) });
    // A Mastra id is not a harness model.
    await expect(resolveHarnessTurnModel(turnDeps, ADA, 'xai/grok-4')).resolves.toBeUndefined();
  });

  it('reads when usage comes back from the provider’s 429', () => {
    expect(rateLimitOf({ statusCode: 429, responseHeaders: { 'anthropic-ratelimit-unified-reset': '1795000000' } }, NOW)?.resetsAt?.getTime()).toBe(1_795_000_000_000);
    expect(
      rateLimitOf({ statusCode: 429, responseBody: JSON.stringify({ error: { type: 'usage_limit_reached', resets_in_seconds: 30 } }) }, NOW)?.resetsAt?.toISOString(),
    ).toBe('2026-11-15T12:00:30.000Z');
    expect(rateLimitOf({ cause: { statusCode: 429 } }, NOW)).toMatchObject({ message: expect.any(String) });
    expect(rateLimitOf({ statusCode: 500 }, NOW)).toBeUndefined();
  });
});
