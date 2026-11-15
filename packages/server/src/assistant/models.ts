/**
 * «Помічник»'s models (ADR-0051): the organization's catalog as Factory presents it, and how the
 * assistant runs each model.
 *
 * The catalog is Factory's own, from the same builders as `/web/config/models`:
 * - Mastra's models (`buildModelCatalog` over the organization's model credentials, Settings › Моделі),
 *   one group per provider, run as Mastra runs them (`resolveModel`, with the Codex OAuth remap);
 * - every other harness's models, from its facet in the server's harness model registry (ADR-0044):
 *   Claude Code's, Codex's, OpenCode's. Factory runs these through their CLIs on the sign-ins and
 *   accounts of Settings › Підключення (ADR-0036/0046). The assistant has no CLI, so it calls the
 *   provider's API with the same credentials, picked from the same account pools:
 *   - Claude Code: the person's Claude sign-ins (`claude_login`), Anthropic's API with the OAuth
 *     access token (Mastra's Claude Max provider: OAuth betas + the Claude Code identity prompt);
 *   - Codex: the person's ChatGPT sign-ins (`codex_login`), the Codex backend with the OAuth token
 *     and workspace (Mastra's Codex provider);
 *   - OpenCode: the organization's OpenCode accounts, OpenCode's API with the account's key.
 *     OpenCode's keyless free models run only inside the `opencode` CLI: without an account they
 *     are listed as Factory-sessions-only.
 *   A harness with no such runner is listed as Factory-sessions-only, never swapped for another.
 *
 * A sign-in serves only its owner's runs (`pickCredentialAccount`), so another member's Claude
 * sign-in does not run this person's assistant: that model says so, with where to connect one.
 */
import { AssistantError, AssistantTurnError } from '@factory/assistant-core';
import type {
  AssistantCatalogModel,
  AssistantModelAvailability,
  AssistantModelCatalog,
  AssistantModelCredential,
  AssistantModelDefault,
  AssistantModelGroup,
  AssistantOwner,
} from '@factory/assistant-core';
import { getAuthProviderId, getTenantCredentialsStorage, pickCredentialAccount, providerDisplayName, usableBy } from '@factory/credentials';
import type { ModelCatalogEntry } from '@factory/credentials';
import { ClaudeCodeError, CLAUDE_CODE_INSTANCE_ID, compileClaudeModelSelection } from '@factory/harness-claude-code';
import { CodexError, CODEX_INSTANCE_ID } from '@factory/harness-codex';
import { OpenCodeError, OPENCODE_INSTANCE_ID } from '@factory/harness-opencode';
import type { ServerProviderModel } from '@factory/harness/models/contracts';
import type { HarnessModelContext, HarnessModels } from '@factory/harness/models/facet';
import type { CredentialAccountKind, CredentialRecord, ModelCredentialsStorage } from '@factory/store';
import type { AuthCredential, CredentialStore } from '@mastra/code-sdk/auth/types';
import { PROVIDER_DEFAULT_MODELS } from '@mastra/code-sdk/auth/storage';
import { opencodeClaudeMaxProvider } from '@mastra/code-sdk/providers/claude-max';
import { openaiCodexProvider } from '@mastra/code-sdk/providers/openai-codex';
import { ModelRouterLanguageModel } from '@mastra/core/llm';

import { createClaudeCodeCredentials } from '../claude/credentials.ts';
import { createCodexCredentials } from '../codex/credentials.ts';
import { createOpenCodeAccounts } from '../opencode/accounts.ts';
import { createPooledModel } from './pooled-model.ts';
import type { ModelAccountPool } from './pooled-model.ts';

/** `<harness instance>:<model>`: a model the assistant runs on a harness's sign-ins or accounts. */
const HARNESS_MODEL_ID = /^([a-z0-9][a-z0-9-]*):(.+)$/;

export function harnessModelId(instanceId: string, slug: string): string {
  return `${instanceId}:${slug}`;
}

/** The harness instance and model of a `<harness>:<model>` id; `undefined` for a Mastra `provider/model` id. */
export function parseHarnessModelId(id: string): { instanceId: string; slug: string } | undefined {
  const match = HARNESS_MODEL_ID.exec(id);
  return match ? { instanceId: match[1]!, slug: match[2]! } : undefined;
}

/** How the assistant runs one harness's models: the credentials it picks, and the model it builds. */
export interface AssistantHarnessRunner {
  credential: Exclude<AssistantModelCredential, 'api_key' | 'provider_oauth' | 'deployment' | 'cli_only'>;
  /** What the group calls the credential ("Claude sign-in"). */
  credentialName: string;
  /** The provider its models come from (`anthropic`, `openai`), when their ids do not name one. */
  provider?: string;
  connector: string;
  /** Whether this person's runs have an account now, later (limited) or none. */
  availability(owner: AssistantOwner): Promise<{ availability: AssistantModelAvailability; credentialLabel?: string }>;
  /** A model the group's credential cannot run though the group can (OpenCode's free ones without an account). */
  modelAvailability?(model: ServerProviderModel, group: AssistantModelAvailability): AssistantModelAvailability | undefined;
  /** The turn's model, on the first usable account, moving to the next on a usage limit. */
  model(owner: AssistantOwner, slug: string): Promise<object>;
}

export interface AssistantModelCatalogDeps {
  /** Mastra's catalog for the organization (`buildModelCatalog`) and the credential rows it came from. */
  mastra(owner: AssistantOwner): Promise<{ models: ModelCatalogEntry[]; credentials: CredentialRecord[] }>;
  /** The model a new Factory chat starts on when its Factory sets no default (`/web/config/models` `fallbackModelId`). */
  factoryChatDefault(owner: AssistantOwner): Promise<string | undefined>;
  /** The server's other harnesses' model facets, in registration order (Mastra's left out). */
  harnesses(): readonly HarnessModels[];
  runners: Readonly<Record<string, AssistantHarnessRunner>>;
}

const READY: AssistantModelAvailability = { state: 'ready' };

function isFreeModelName(name: string): boolean {
  return /(?:-|:)free$/i.test(name);
}

function selectable(availability: AssistantModelAvailability): boolean {
  return availability.state === 'ready' || availability.state === 'limited';
}

function mastraCredential(provider: string, entry: ModelCatalogEntry, credentials: CredentialRecord[]): AssistantModelCredential {
  if (entry.credentialHolder === 'deployment') return 'deployment';
  const record = credentials.find(candidate => candidate.provider === getAuthProviderId(provider));
  return record?.credential.type === 'oauth' ? 'provider_oauth' : 'api_key';
}

interface GroupDefault {
  groupId: string;
  modelId: string;
}

/** The catalog, and each group's own default (what "first runnable by preference" starts from). */
async function buildGroups(
  deps: AssistantModelCatalogDeps,
  owner: AssistantOwner,
): Promise<{ groups: AssistantModelGroup[]; groupDefaults: GroupDefault[] }> {
  const ctx: HarnessModelContext = { viewer: { userId: owner.userId, orgId: owner.orgId } };
  const harnesses = deps.harnesses();
  const harnessLists = await Promise.all(
    harnesses.map(async facet => {
      try {
        return { facet, models: await facet.list(ctx), error: undefined };
      } catch (error) {
        return { facet, models: [] as ServerProviderModel[], error: error instanceof Error ? error.message : String(error) };
      }
    }),
  );
  // OpenCode's catalog marks its free models; Mastra's `opencode/…` ids are the same models.
  const freeSlugs = new Set(harnessLists.flatMap(list => list.models.filter(model => model.badge === 'free').map(model => model.slug)));

  const groups: AssistantModelGroup[] = [];
  const groupDefaults: GroupDefault[] = [];

  const { models: mastraModels, credentials } = await deps.mastra(owner);
  const byProvider = new Map<string, ModelCatalogEntry[]>();
  for (const entry of mastraModels) byProvider.set(entry.provider, [...(byProvider.get(entry.provider) ?? []), entry]);
  for (const [provider, entries] of byProvider) {
    const first = entries[0]!;
    const credential = mastraCredential(provider, first, credentials);
    const groupId = `mastra/${provider}`;
    groups.push({
      id: groupId,
      harness: 'mastra',
      harnessLabel: 'Mastra',
      provider,
      label: providerDisplayName(provider),
      credential,
      ...(first.credentialLabel ? { credentialLabel: first.credentialLabel } : {}),
      availability: READY,
      models: entries.map(entry => ({
        id: entry.id,
        label: entry.modelName,
        provider,
        modelName: entry.modelName,
        free: freeSlugs.has(entry.id) || isFreeModelName(entry.modelName),
        legacy: false,
        selectable: true,
        availability: READY,
      })),
    });
    const preferred = PROVIDER_DEFAULT_MODELS[getAuthProviderId(provider)];
    if (preferred && entries.some(entry => entry.id === preferred)) groupDefaults.push({ groupId, modelId: preferred });
  }
  // Mastra's providers in Mastra's own preference order (`PROVIDER_DEFAULT_MODELS`), as a new chat picks.
  const preference = Object.keys(PROVIDER_DEFAULT_MODELS);
  groupDefaults.sort((a, b) => rank(preference, a.groupId) - rank(preference, b.groupId));

  for (const { facet, models, error } of harnessLists) {
    const runner = deps.runners[facet.instanceId];
    const provider = runner?.provider ?? facet.instanceId;
    const base = { id: facet.instanceId, harness: facet.harnessId, harnessLabel: facet.displayName, provider };
    if (!runner) {
      const availability: AssistantModelAvailability = {
        state: 'sessions_only',
        reason: `${facet.displayName} runs only through its CLI in Factory sessions; the assistant has no API path to its models.`,
      };
      groups.push({
        ...base,
        label: facet.displayName,
        credential: 'cli_only',
        availability,
        models: models.map(model => catalogModel(facet.instanceId, provider, model, availability, false)),
      });
      continue;
    }
    const { availability: accountAvailability, credentialLabel } = await runner.availability(owner);
    let availability = accountAvailability;
    if (models.length === 0) {
      const own = await facet.availability?.(ctx).catch(() => undefined);
      availability = {
        state: 'unavailable',
        reason: error ?? own?.reason ?? `${facet.displayName} lists no models right now.`,
      };
    }
    const label = `${facet.displayName} · ${runner.credentialName}`;
    const groupModels = models.map(model => {
      const modelAvailability = runner.modelAvailability?.(model, availability) ?? availability;
      return catalogModel(facet.instanceId, provider, model, { ...modelAvailability, ...(modelAvailability.state === 'ready' ? {} : { connector: runner.connector }) }, true);
    });
    groups.push({
      ...base,
      label,
      credential: runner.credential,
      ...(credentialLabel ? { credentialLabel } : {}),
      availability: availability.state === 'ready' ? availability : { ...availability, connector: runner.connector },
      models: groupModels,
    });
    const catalogDefault = await facet.catalogDefault(ctx).catch(() => null);
    const slug = catalogDefault?.model ?? models.find(model => model.isDefault)?.slug;
    if (slug && models.some(model => model.slug === slug)) groupDefaults.push({ groupId: facet.instanceId, modelId: harnessModelId(facet.instanceId, slug) });
  }
  return { groups, groupDefaults };
}

function rank(order: string[], groupId: string): number {
  const index = order.indexOf(getAuthProviderId(groupId.replace(/^mastra\//, '')));
  return index < 0 ? order.length : index;
}

function catalogModel(instanceId: string, harnessProvider: string, model: ServerProviderModel, availability: AssistantModelAvailability, runnable: boolean): AssistantCatalogModel {
  const [provider, ...rest] = model.slug.includes('/') ? model.slug.split('/') : [harnessProvider, model.slug];
  return {
    id: harnessModelId(instanceId, model.slug),
    label: model.name,
    provider: provider!,
    modelName: rest.join('/'),
    free: model.badge === 'free',
    legacy: model.isLegacy ?? false,
    selectable: runnable && selectable(availability),
    availability,
  };
}

/**
 * The default a person who picked none runs on:
 * 1. the model a new Factory chat of this organization starts on (no Factory default set), when the
 *    assistant can run it now;
 * 2. otherwise the first runnable model in the organization's order: Mastra's providers in Mastra's
 *    preference order, then each harness's own default in registration order, then any ready model.
 */
export function resolveAssistantDefault(
  groups: AssistantModelGroup[],
  groupDefaults: GroupDefault[],
  factoryChatDefault: string | undefined,
): { default: AssistantModelDefault | null; defaultReason: string } {
  const all = groups.flatMap(group => group.models.map(model => ({ group, model })));
  const find = (id: string | undefined) => (id ? all.find(entry => entry.model.id === id) : undefined);
  const factory = find(factoryChatDefault);
  if (factory && factory.model.availability.state === 'ready') {
    const reason = `A new Factory chat of this organization starts on ${factory.model.label} (${factory.group.label}) when its Factory sets no default, and the assistant can run it.`;
    return { default: { modelId: factory.model.id, label: factory.model.label, source: 'factory_default', reason }, defaultReason: reason };
  }
  const why = !factoryChatDefault
    ? 'Factory names no built-in default model for a new chat here'
    : !factory
      ? `a new Factory chat would start on ${factoryChatDefault}, which this organization has no credential for`
      : `a new Factory chat starts on ${factory.model.label}, which the assistant cannot run now (${factory.model.availability.reason ?? factory.model.availability.state})`;
  const ready = (id: string) => {
    const entry = find(id);
    return entry && entry.model.availability.state === 'ready' && entry.model.selectable ? entry : undefined;
  };
  const picked =
    groupDefaults.map(candidate => ready(candidate.modelId)).find(Boolean) ??
    all.find(entry => entry.model.selectable && entry.model.availability.state === 'ready' && !entry.model.legacy);
  if (!picked) {
    const defaultReason = `No model of this organization can run the assistant now: ${why}, and no other model is ready. An admin connects one in Settings › Моделі, or you connect a sign-in in Settings › Підключення.`;
    return { default: null, defaultReason };
  }
  const reason = `${why[0]!.toUpperCase()}${why.slice(1)}, so the assistant starts on ${picked.model.label} (${picked.group.label}), the first runnable model in the organization's order.`;
  return { default: { modelId: picked.model.id, label: picked.model.label, source: 'org_preference', reason }, defaultReason: reason };
}

export async function buildAssistantModelCatalog(deps: AssistantModelCatalogDeps, owner: AssistantOwner): Promise<AssistantModelCatalog> {
  const [{ groups, groupDefaults }, factoryChatDefault] = await Promise.all([
    buildGroups(deps, owner),
    deps.factoryChatDefault(owner).catch(() => undefined),
  ]);
  return { groups, ...resolveAssistantDefault(groups, groupDefaults, factoryChatDefault) };
}

/** A harness model's turn model: on its runner, or a loud refusal naming why it cannot run here. */
export async function resolveHarnessTurnModel(
  deps: Pick<AssistantModelCatalogDeps, 'runners' | 'harnesses'>,
  owner: AssistantOwner,
  id: string,
): Promise<object | undefined> {
  const parsed = parseHarnessModelId(id);
  if (!parsed) return undefined;
  const facet = deps.harnesses().find(candidate => candidate.instanceId === parsed.instanceId);
  const runner = deps.runners[parsed.instanceId];
  if (!facet && !runner) return undefined;
  if (!runner) {
    throw new AssistantTurnError(
      id,
      Object.assign(new Error(`${facet?.displayName ?? parsed.instanceId} runs only through its CLI in Factory sessions; pick another model for the assistant.`), {
        statusCode: 404,
      }),
    );
  }
  try {
    return await runner.model(owner, parsed.slug);
  } catch (error) {
    throw new AssistantTurnError(id, error);
  }
}

// ---- Account availability -------------------------------------------------------------------

async function accountAvailability(input: {
  credentials: ModelCredentialsStorage | undefined;
  owner: AssistantOwner;
  provider: string;
  kind: CredentialAccountKind;
  now: Date;
  none: string;
  othersOnly?: string;
  allOff: string;
}): Promise<{ availability: AssistantModelAvailability; credentialLabel?: string }> {
  const storage = await getTenantCredentialsStorage(input.credentials);
  const accounts = storage ? (await storage.listAccounts(input.owner.orgId, input.provider)).filter(account => account.kind === input.kind) : [];
  const picked = pickCredentialAccount(accounts, { userId: input.owner.userId, now: input.now });
  if (picked.account) return { availability: READY, credentialLabel: picked.account.label };
  if (picked.resetsAt) {
    return {
      availability: {
        state: 'limited',
        until: picked.resetsAt.toISOString(),
        reason: `Every account it may use is out of usage; the first comes back at ${picked.resetsAt.toISOString()}.`,
      },
    };
  }
  const mine = accounts.filter(account => usableBy(account, input.owner.userId));
  if (mine.length > 0 && mine.every(account => account.disabled)) return { availability: { state: 'no_credentials', reason: input.allOff } };
  if (input.othersOnly && accounts.some(account => !account.disabled)) return { availability: { state: 'no_credentials', reason: input.othersOnly } };
  return { availability: { state: 'no_credentials', reason: input.none } };
}

/** A pool's refusal as the turn reports it: out of usage (429, with when) or nothing to run on (401). */
function poolError(error: unknown, missing: string): Error {
  const kind = (error as { kind?: unknown } | undefined)?.kind;
  if (kind === 'rate_limit') {
    const resetsAt = (error as { resetsAt?: Date }).resetsAt;
    return Object.assign(new Error((error as Error).message, { cause: error }), { statusCode: 429, kind: 'rate_limit', ...(resetsAt ? { resetsAt } : {}) });
  }
  const message = error instanceof Error && /no other .* account/i.test(error.message) ? error.message : missing;
  return Object.assign(new Error(message, { cause: error }), { statusCode: 401, kind: 'auth' });
}

/** One sign-in's OAuth token as the credential store Mastra's OAuth providers read. */
export function signInCredentialStore(provider: string, oauth: { access: string; accountId?: string }): CredentialStore {
  const credential: AuthCredential = {
    type: 'oauth',
    access: oauth.access,
    refresh: '',
    // The pool refreshed it with at least ten minutes left; a turn that outlives it fails as the provider says.
    expires: Date.now() + 10 * 60_000,
    ...(oauth.accountId ? { accountId: oauth.accountId } : {}),
  };
  return {
    allowEnvironmentFallback: false,
    reload() {},
    get: candidate => (candidate === provider ? credential : undefined),
    getStoredApiKey: () => undefined,
    getApiKey: async candidate => (candidate === provider ? oauth.access : undefined),
    getOAuthCredential: async candidate => (candidate === provider ? { ...credential, type: 'oauth' as const } : undefined),
  };
}

interface RunnerOptions {
  credentials: ModelCredentialsStorage | undefined;
  now?: () => Date;
  /** The OAuth refresh's transport (tests). */
  fetch?: typeof fetch;
}

const CLAUDE_MISSING =
  'No Claude sign-in of yours is connected: the assistant runs Claude Code models on your own Claude sign-in. Connect one under Settings › Підключення › Claude Code.';

/** Claude Code's models on the person's Claude sign-ins, through Anthropic's API (Mastra's Claude Max provider). */
export function createClaudeSignInRunner(
  options: RunnerOptions & { build?: (apiModelId: string, accessToken: string) => object },
): AssistantHarnessRunner {
  const now = options.now ?? (() => new Date());
  const hooks = createClaudeCodeCredentials({ credentials: options.credentials, now, ...(options.fetch ? { fetch: options.fetch } : {}) });
  const build =
    options.build ??
    ((apiModelId: string, accessToken: string) =>
      opencodeClaudeMaxProvider(apiModelId, { authStorage: signInCredentialStore('anthropic', { access: accessToken }) }) as object);
  return {
    credential: 'claude_login',
    credentialName: 'Claude sign-in',
    provider: 'anthropic',
    connector: 'claude-code',
    availability: owner =>
      accountAvailability({
        credentials: options.credentials,
        owner,
        provider: 'anthropic',
        kind: 'claude_login',
        now: now(),
        none: CLAUDE_MISSING,
        othersOnly:
          "The organization's Claude sign-ins belong to other members, and a sign-in runs only its owner's work. Connect your own under Settings › Підключення › Claude Code.",
        allOff: 'Every Claude sign-in of yours is turned off (it needs a new sign-in under Settings › Підключення › Claude Code).',
      }),
    async model(owner, slug) {
      // A CLI alias (`opus`) or option-bearing pick becomes the API model id the CLI would run.
      const apiModelId = compileClaudeModelSelection({ instanceId: CLAUDE_CODE_INSTANCE_ID, model: slug }).apiModelId ?? slug;
      const tenant = { orgId: owner.orgId, userId: owner.userId };
      const pool: ModelAccountPool<object> = {
        async pick(request) {
          let picked;
          try {
            picked = await hooks.credentials(tenant, request);
          } catch (error) {
            throw poolError(error, CLAUDE_MISSING);
          }
          const env = 'env' in picked && typeof picked.env === 'object' ? (picked.env as Record<string, string>) : (picked as Record<string, string>);
          const accountId = 'accountId' in picked && typeof picked.accountId === 'string' ? picked.accountId : 'claude';
          return { accountId, model: build(apiModelId, env.CLAUDE_CODE_OAUTH_TOKEN ?? '') };
        },
        park: (accountId, failure) =>
          hooks.onCredentialFailure(tenant, { accountId, error: new ClaudeCodeError('rate_limit', failure.message, { resetsAt: failure.resetsAt, now: now() }) }),
      };
      return createPooledModel({ pool, now });
    },
  };
}

const CODEX_MISSING =
  'No ChatGPT sign-in of yours is connected: the assistant runs Codex models on your own ChatGPT sign-in. Connect one under Settings › Підключення › Codex.';

/** Codex's models on the person's ChatGPT sign-ins, through the Codex backend (Mastra's Codex OAuth provider). */
export function createCodexSignInRunner(
  options: RunnerOptions & { build?: (slug: string, tokens: { accessToken: string; chatgptAccountId: string }) => object },
): AssistantHarnessRunner {
  const now = options.now ?? (() => new Date());
  const hooks = createCodexCredentials({ credentials: options.credentials, now, ...(options.fetch ? { fetch: options.fetch } : {}) });
  const build =
    options.build ??
    ((slug: string, tokens: { accessToken: string; chatgptAccountId: string }) =>
      openaiCodexProvider(slug, {
        authStorage: signInCredentialStore('openai-codex', { access: tokens.accessToken, accountId: tokens.chatgptAccountId }),
      }) as object);
  return {
    credential: 'codex_login',
    credentialName: 'ChatGPT sign-in',
    provider: 'openai',
    connector: 'codex',
    availability: owner =>
      accountAvailability({
        credentials: options.credentials,
        owner,
        provider: 'openai-codex',
        kind: 'codex_login',
        now: now(),
        none: CODEX_MISSING,
        othersOnly:
          "The organization's ChatGPT sign-ins belong to other members, and a sign-in runs only its owner's work. Connect your own under Settings › Підключення › Codex.",
        allOff: 'Every ChatGPT sign-in of yours is turned off (it needs a new sign-in under Settings › Підключення › Codex).',
      }),
    async model(owner, slug) {
      const tenant = { orgId: owner.orgId, userId: owner.userId };
      const pool: ModelAccountPool<object> = {
        async pick(request) {
          try {
            const picked = await hooks.credentials(tenant, request);
            return { accountId: picked.accountId ?? 'codex', model: build(slug, picked.tokens) };
          } catch (error) {
            throw poolError(error, CODEX_MISSING);
          }
        },
        park: (accountId, failure) =>
          hooks.onCredentialFailure(tenant, { accountId, error: new CodexError('rate_limit', failure.message, { resetsAt: failure.resetsAt }) }),
      };
      return createPooledModel({ pool, now });
    },
  };
}

const OPENCODE_FREE_CLI_ONLY =
  "OpenCode's free models run without a key only inside the opencode CLI (Factory sessions). Connect an OpenCode account under Settings › Підключення › OpenCode to run them in the assistant.";

/** OpenCode's models on the organization's OpenCode accounts, through OpenCode's API with the account's key. */
export function createOpenCodeAccountRunner(
  options: RunnerOptions & { build?: (slug: string, apiKey: string) => object },
): AssistantHarnessRunner {
  const now = options.now ?? (() => new Date());
  const accounts = createOpenCodeAccounts({ credentials: options.credentials, now, ...(options.fetch ? { fetch: options.fetch } : {}) });
  const build =
    options.build ?? ((slug: string, apiKey: string) => new ModelRouterLanguageModel({ id: slug as `${string}/${string}`, apiKey }) as object);
  return {
    credential: 'opencode_account',
    credentialName: 'OpenCode account',
    provider: 'opencode',
    connector: 'opencode',
    availability: owner =>
      accountAvailability({
        credentials: options.credentials,
        owner,
        provider: 'opencode',
        kind: 'api_key',
        now: now(),
        none: OPENCODE_FREE_CLI_ONLY,
        allOff: 'Every OpenCode account of this organization is turned off. Give one a new key under Settings › Підключення › OpenCode.',
      }),
    modelAvailability(model, group) {
      // Without an account, the catalog holds only the free models, which only the CLI runs keyless.
      if (group.state === 'no_credentials' && model.badge === 'free') return { state: 'sessions_only', reason: OPENCODE_FREE_CLI_ONLY };
      return undefined;
    },
    async model(owner, slug) {
      const tenant = { orgId: owner.orgId, userId: owner.userId };
      const pool: ModelAccountPool<object> = {
        async pick(request) {
          let picked;
          try {
            picked = await accounts.credentials(tenant, request);
          } catch (error) {
            throw poolError(error, OPENCODE_FREE_CLI_ONLY);
          }
          if (!picked) throw poolError(undefined, request.exclude.length ? 'No other OpenCode account is available for this run.' : OPENCODE_FREE_CLI_ONLY);
          return { accountId: picked.accountId, model: build(slug, picked.apiKey) };
        },
        park: (accountId, failure) =>
          accounts.onCredentialFailure(tenant, { accountId, error: new OpenCodeError('rate_limit', failure.message, { resetsAt: failure.resetsAt }) }),
      };
      return createPooledModel({ pool, now });
    },
  };
}

/** The runners of the harnesses this server knows an API path for, keyed by their instance id. */
export function createAssistantHarnessRunners(options: RunnerOptions): Record<string, AssistantHarnessRunner> {
  return {
    [CLAUDE_CODE_INSTANCE_ID]: createClaudeSignInRunner(options),
    [CODEX_INSTANCE_ID]: createCodexSignInRunner(options),
    [OPENCODE_INSTANCE_ID]: createOpenCodeAccountRunner(options),
  };
}

/** The organization-level refusal when nothing can run (kept as the thread's `no_model` failure). */
export function noOrgModelError(reason: string): AssistantError {
  return new AssistantError('no_org_model', `Your organization has no model connected, so the assistant cannot answer. ${reason}`, 409);
}
