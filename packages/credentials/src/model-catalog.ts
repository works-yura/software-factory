// Model catalog and provider access, cut from v3 routes/config.ts so sessions and tools can use it without the routes.

import type { AuthStorage } from '@mastra/code-sdk/auth/storage';
import type { ProviderAccess, ProviderAccessLevel } from '@mastra/code-sdk/onboarding/packs';
import { AMAZON_BEDROCK_GATEWAY_ID } from '@mastra/code-sdk/providers/amazon-bedrock-gateway';
import { getModelReasoningOptions, getProviderConfig } from '@mastra/core/llm';
import type { ModelReasoningOption } from '@mastra/core/llm';
import { getAvailableThinkingLevelsForModel } from '@mastra/code-sdk/thinking';
import type { ModelCapabilities } from '@factory/harness/models/contracts';
import type { CredentialRecord, LoginSessionKind, ModelCredentialsStorage } from '@factory/store';
import type { CustomProviderRecord } from '@factory/store';
import { mastraModelCapabilities } from './mastra-models.ts';
import { credentialLabel, getAuthProviderId, WEB_OAUTH_PROVIDERS } from './provider-credentials.ts';

/**
 * Where a provider's active credential comes from, as seen by the caller.
 * Local mode reports `oauth`/`stored` (server-global `auth.json`); tenant mode
 * reports the scoped variants (`oauth-user`/`stored-user`/`stored-org`).
 * `deployment` (tenant mode) marks a provider the operator opted in to run on
 * the server process's own credentials (e.g. Amazon Bedrock's AWS chain).
 */
export type ProviderCredentialSource =
  | 'deployment'
  | 'oauth'
  | 'stored'
  | 'env'
  | 'none'
  | 'oauth-user'
  | 'oauth-org'
  | 'stored-user'
  | 'stored-org';

/** A model provider with the current source of its credentials. */
export interface ProviderInfo {
  provider: string;
  /** Env var the provider's key is read from, if any. */
  envVar?: string;
  /** Where the active credential comes from. */
  source: ProviderCredentialSource;
  /**
   * Tenant mode: whether an org-wide API key exists for this provider, even
   * when the caller's personal credential shadows it. Lets the UI tell
   * "shared with the org" apart from "only works for me".
   */
  orgKey?: boolean;
  /**
   * Tenant mode: the caller's personal credential for this provider, if any.
   * Reported independently of `source` so the UI can manage each scope even
   * when one shadows the other.
   */
  userCredential?: 'oauth' | 'api_key';
  /** Tenant mode: the shared org credential for this provider, if any. */
  orgCredential?: 'oauth' | 'api_key';
  /** Web OAuth sign-in capability, when the provider supports it. */
  oauth?: { supported: true; modes: LoginSessionKind[] };
}

/** Minimal session surface the config routes touch. */
export interface OMSession {
  /** `get()` returns '' when no model is selected, so callers fall back on falsy. */
  model: { get: () => string; switch?: (modelId: string) => Promise<void> };
  thread?: { getId: () => string | null };
}

/** Minimal controller surface this module needs (model catalog + modes + sessions). */
export interface ModelCatalog {
  listAvailableModels: () => Promise<
    Array<{ id?: string; modelName: string; provider: string; hasApiKey: boolean; apiKeyEnvVar?: string }>
  >;
  listModes?: () => Array<{ id: string; defaultModelId?: string }>;
  /** The mode new sessions start in; the built-in model pick starts from its model. */
  getDefaultMode?: () => { defaultModelId?: string };
  getSession?: (sessionId: string) => Promise<OMSession | undefined>;
}

/**
 * Build a deduplicated, sorted list of providers from the model catalog,
 * annotated with where each provider's credential currently comes from.
 * Mirrors the TUI's `/api-keys` provider list.
 *
 * When `tenantCredentials` is given (deployed mode), sources reflect the
 * *caller's* tenant rows with user > org precedence and the server-global
 * `authStorage` is ignored; otherwise the local `auth.json` view is reported.
 */
export async function listProviders({
  controller,
  authStorage,
  tenantCredentials,
  deploymentProviders,
}: {
  controller: ModelCatalog;
  authStorage?: AuthStorage;
  tenantCredentials?: CredentialRecord[];
  deploymentProviders?: ReadonlySet<string>;
}): Promise<ProviderInfo[]> {
  const models = await controller.listAvailableModels();
  const seen = new Map<string, ProviderInfo>();

  for (const model of models) {
    if (seen.has(model.provider)) continue;

    if (tenantCredentials && isDeploymentModelProvider(model.provider)) {
      // Credentials for these providers live on the server process, never in
      // tenant rows, so no account can connect them. List them only when the
      // operator opted the deployment in and the server has credentials.
      const usable =
        deploymentProviders?.has(model.provider) && models.some(m => m.provider === model.provider && m.hasApiKey);
      if (usable) seen.set(model.provider, { provider: model.provider, source: 'deployment' });
      continue;
    }

    const authProviderId = getAuthProviderId(model.provider);
    let source: ProviderInfo['source'] = 'none';
    let orgKey: boolean | undefined;
    let userCredential: ProviderInfo['userCredential'];
    let orgCredential: ProviderInfo['orgCredential'];
    if (tenantCredentials) {
      const userRec = tenantCredentials.find(r => r.scope === 'user' && r.provider === authProviderId);
      const orgRec = tenantCredentials.find(r => r.scope === 'org' && r.provider === authProviderId);
      // Any shared org credential (API key or org-wide OAuth) counts.
      orgKey = orgRec !== undefined;
      userCredential = userRec?.credential.type;
      orgCredential = orgRec?.credential.type;
      if (userRec?.credential.type === 'oauth') {
        source = 'oauth-user';
      } else if (userRec?.credential.type === 'api_key') {
        source = 'stored-user';
      } else if (orgRec?.credential.type === 'oauth') {
        source = 'oauth-org';
      } else if (orgRec?.credential.type === 'api_key') {
        source = 'stored-org';
      }
    } else if (authStorage?.isLoggedIn(authProviderId)) {
      source = 'oauth';
    } else if (authStorage?.hasStoredApiKey(model.provider)) {
      source = 'stored';
    } else if (model.apiKeyEnvVar && process.env[model.apiKeyEnvVar]) {
      source = 'env';
    } else if (model.hasApiKey) {
      source = 'env';
    }

    const flowKind = WEB_OAUTH_PROVIDERS[model.provider]?.flow;
    seen.set(model.provider, {
      provider: model.provider,
      envVar: model.apiKeyEnvVar,
      source,
      ...(orgKey !== undefined ? { orgKey } : {}),
      ...(userCredential ? { userCredential } : {}),
      ...(orgCredential ? { orgCredential } : {}),
      ...(flowKind ? { oauth: { supported: true as const, modes: [flowKind] } } : {}),
    });
  }

  return Array.from(seen.values()).sort((a, b) => a.provider.localeCompare(b.provider));
}

/**
 * Providers whose credentials can only come from the server process (Amazon
 * Bedrock authenticates through the AWS credential chain). In tenant mode they
 * are usable only when the operator lists them in
 * `MastraFactoryConfig.deploymentModelProviders`.
 */
export const DEPLOYMENT_MODEL_PROVIDERS: readonly string[] = [AMAZON_BEDROCK_GATEWAY_ID];

export function isDeploymentModelProvider(provider: string): boolean {
  return DEPLOYMENT_MODEL_PROVIDERS.includes(provider);
}

/**
 * Normalize the operator's `deploymentModelProviders` list. Unsupported ids are
 * ignored with a warning rather than failing boot.
 */
export function resolveDeploymentModelProviders(providers: readonly string[] | undefined): ReadonlySet<string> {
  const resolved = new Set<string>();
  for (const raw of providers ?? []) {
    const provider = raw.trim();
    if (!provider) continue;
    if (isDeploymentModelProvider(provider)) {
      resolved.add(provider);
    } else {
      console.warn(
        `[factory] Ignoring deployment model provider "${provider}". Supported: ${DEPLOYMENT_MODEL_PROVIDERS.join(', ')}.`,
      );
    }
  }
  return resolved;
}

function grantingTenantRecord(records: CredentialRecord[], authProviderId: string) {
  return (
    records.find(r => r.scope === 'user' && r.provider === authProviderId) ??
    records.find(r => r.scope === 'org' && r.provider === authProviderId)
  );
}

export type ModelCredentialHolder = 'personal' | 'organization' | 'deployment';

function tenantModelCredential(
  records: CredentialRecord[] | undefined,
  provider: string,
): { credentialLabel?: string; credentialHolder?: ModelCredentialHolder } {
  if (!records) return {};
  if (isDeploymentModelProvider(provider)) return { credentialHolder: 'deployment' };
  const record = grantingTenantRecord(records, getAuthProviderId(provider));
  if (!record) return {};
  return {
    credentialLabel: credentialLabel(provider, record.credential.type),
    credentialHolder: record.scope === 'user' ? 'personal' : 'organization',
  };
}

/**
 * Compute which providers the user can reach, mirroring the TUI's
 * `/models-pack` access derivation: OAuth/api-key from the credential store for
 * the named providers, plus any other provider that has a usable key.
 */
export async function buildProviderAccess({
  controller,
  authStorage,
  tenantCredentials,
  deploymentProviders,
}: {
  controller: ModelCatalog;
  authStorage?: AuthStorage;
  tenantCredentials?: CredentialRecord[];
  deploymentProviders?: ReadonlySet<string>;
}): Promise<ProviderAccess> {
  const models = await controller.listAvailableModels();
  const hasModelKey = (provider: string) => models.some(m => m.provider === provider && m.hasApiKey);
  const accessLevel = (provider: string): ProviderAccessLevel => {
    const authProviderId = getAuthProviderId(provider);
    if (tenantCredentials) {
      // Tenant rows never authenticate these providers; only an operator
      // opt-in plus credentials on the server process does.
      if (isDeploymentModelProvider(provider)) {
        return deploymentProviders?.has(provider) && hasModelKey(provider) ? 'apikey' : false;
      }
      const credential = grantingTenantRecord(tenantCredentials, authProviderId)?.credential;
      if (credential?.type === 'oauth') return 'oauth';
      if (credential?.type === 'api_key' && credential.key.trim().length > 0) return 'apikey';
      return false;
    }

    const oauthCredential = authStorage?.get(authProviderId);
    if (oauthCredential?.type === 'oauth') return 'oauth';
    if (authStorage?.hasStoredApiKey(provider)) return 'apikey';
    const directCredential = authStorage?.get(provider);
    if (directCredential?.type === 'api_key' && directCredential.key.trim().length > 0) return 'apikey';
    return hasModelKey(provider) ? 'apikey' : false;
  };
  const access: ProviderAccess = {
    anthropic: accessLevel('anthropic'),
    openai: accessLevel('openai'),
    cerebras: accessLevel('cerebras'),
    google: accessLevel('google'),
    deepseek: accessLevel('deepseek'),
    'github-copilot': accessLevel('github-copilot'),
  };
  const seen = new Set(Object.keys(access));
  for (const m of models) {
    if (!seen.has(m.provider)) {
      access[m.provider] = accessLevel(m.provider);
      seen.add(m.provider);
    }
  }
  return access;
}

/**
 * A model its provider has retired (the registry's `deprecatedModels`): it still lists, but a run on it fails
 * ("Model is unavailable"), so it is not offered for picking.
 */
export function isDeprecatedModel(provider: string, modelName: string): boolean {
  return getProviderConfig(provider)?.deprecatedModels?.includes(modelName) ?? false;
}

function canUseModelProvider(access: ProviderAccess, provider: string): boolean {
  return Boolean(access[provider]);
}

/** A model the caller can pick or switch to. */
export interface ModelCatalogEntry {
  id: string;
  provider: string;
  modelName: string;
  hasApiKey: true;
  reasoningOptions?: ModelReasoningOption[];
  /**
   * The model's options as `ProviderOptionDescriptor`s: a `select` `effort` (role `reasoning`) over the
   * thinking levels it runs at, which a session takes as `thinkingLevel`. Empty when it has no choice.
   * Always set by `buildModelCatalog`; optional so older clients' fixtures still type.
   */
  capabilities?: ModelCapabilities;
  credentialLabel?: string;
  credentialHolder?: ModelCredentialHolder;
}

/** A Mastra model's option descriptors, from the thinking levels Mastra Code runs it at. */
export function mastraCatalogCapabilities(id: string, reasoningOptions: ModelReasoningOption[] | undefined): ModelCapabilities {
  return mastraModelCapabilities(getAvailableThinkingLevelsForModel(id, reasoningOptions));
}

/**
 * Models usable with the given credentials: built-in models whose provider the
 * credentials reach, then the org's custom provider models. The Settings model
 * picker and `factory_switch_session_model` both use this so they cannot drift.
 */
export async function buildModelCatalog({
  controller,
  authStorage,
  tenantCredentials,
  deploymentProviders,
  listCustomProviders,
}: {
  controller: ModelCatalog;
  authStorage?: AuthStorage;
  /** Tenant rows in deployed mode; absent in local mode, where `authStorage` and server keys govern. */
  tenantCredentials?: CredentialRecord[];
  deploymentProviders?: ReadonlySet<string>;
  listCustomProviders?: () => Promise<CustomProviderRecord[]>;
}): Promise<ModelCatalogEntry[]> {
  const [models, access] = await Promise.all([
    controller.listAvailableModels(),
    buildProviderAccess({
      controller,
      authStorage: tenantCredentials ? undefined : authStorage,
      tenantCredentials,
      deploymentProviders,
    }),
  ]);
  const catalog: ModelCatalogEntry[] = models.flatMap(({ id, provider, modelName }) =>
    typeof id === 'string' && canUseModelProvider(access, provider) && !isDeprecatedModel(provider, modelName)
      ? [
          {
            id,
            provider,
            modelName,
            hasApiKey: true as const,
            reasoningOptions: getModelReasoningOptions(id),
            capabilities: mastraCatalogCapabilities(id, getModelReasoningOptions(id)),
            ...tenantModelCredential(tenantCredentials, provider),
          },
        ]
      : [],
  );
  // The boot-time gateway catalog only carries the local custom providers, so
  // tenant callers get their org's rows here. Dedupe against ids already present.
  if (listCustomProviders) {
    try {
      const known = new Set(catalog.map(m => m.id));
      const customProviderCredential: { credentialHolder?: ModelCredentialHolder } = tenantCredentials
        ? { credentialHolder: 'organization' }
        : {};
      for (const record of await listCustomProviders()) {
        for (const model of record.models) {
          const id = `${record.providerId}/${model}`;
          if (known.has(id)) continue;
          known.add(id);
          catalog.push({
            id,
            provider: record.providerId,
            modelName: model,
            hasApiKey: true,
            capabilities: mastraCatalogCapabilities(id, undefined),
            ...customProviderCredential,
          });
        }
      }
    } catch {
      // Fail soft: the catalog still serves the built-in models.
    }
  }
  return catalog.sort((a, b) =>
    a.provider === b.provider ? a.id.localeCompare(b.id) : a.provider.localeCompare(b.provider),
  );
}

/**
 * The tenant credentials a session's model policy allows: the organization's
 * rows only. Personal rows an older build stored are never offered.
 */
export async function listSessionScopedCredentials({
  credentials,
  orgId,
  userId,
}: {
  credentials: Pick<ModelCredentialsStorage, 'listCredentials'>;
  orgId: string;
  userId: string;
}): Promise<CredentialRecord[]> {
  return (await credentials.listCredentials(orgId, userId)).filter(record => record.scope === 'org');
}
