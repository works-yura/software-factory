import { MastraCodeGateway } from '@mastra/code-sdk/agents/mastracode-gateway';
import type { AuthStorage } from '@mastra/code-sdk/auth/storage';
import { resolveAutoOMModelId } from '@mastra/code-sdk/onboarding/packs';
import { getCustomProviderId, MASTRA_GATEWAY_PROVIDER } from '@mastra/code-sdk/onboarding/settings';
import type { CustomProviderSetting } from '@mastra/code-sdk/onboarding/settings';
import { MASTRA_GATEWAY_PREFIX } from '@mastra/code-sdk/providers/model-ids';
import { RequestContext } from '@mastra/core/request-context';
import type { ApiRoute } from '@mastra/core/server';
import { registerApiRoute } from '@mastra/core/server';
import type { Context } from 'hono';
import { z } from 'zod';
import { resolveFactoryModelPolicy } from '@factory/session';
import { DEFAULT_OBSERVATION_THRESHOLD, DEFAULT_REFLECTION_THRESHOLD } from '@factory/session';
import type { ModelCredentialsStorage } from '@factory/store';
import type { CustomProviderRecord, CustomProvidersStorage } from '@factory/store';
import { factoryMemorySettingsUserId } from '@factory/store';
import type { MemorySettingsPatch, MemorySettingsRecord, MemorySettingsStorage } from '@factory/store';
import type { FactoryProjectsStorage } from '@factory/store';
import type { SourceControlStorageHandle } from '@factory/store';
import type { WorkItemsStorage } from '@factory/store';
import {
  getAuthProviderId,
  listTenantCredentialsForRequest,
  resolveCredentialContext,
  resolveTenantProviderDefaultModel,
  tenantOrgId,
} from '@factory/credentials';
import { Route } from '@factory/http';
import type { RouteAuth, RouteDependencies } from '@factory/http';
import type { HarnessModelContext, HarnessModelInstanceInfo } from '@factory/harness/models/facet';
import type { HarnessModelRegistry } from '@factory/harness/models/registry';
import { MASTRA_INSTANCE_ID, mastraModelInstance } from '@factory/credentials/mastra-models';
import { listProviders, DEPLOYMENT_MODEL_PROVIDERS, isDeploymentModelProvider, buildProviderAccess, buildModelCatalog, listSessionScopedCredentials } from '@factory/credentials';
import type { ModelCatalog, ModelCatalogEntry } from '@factory/credentials';
import { CLAUDE_CODE_HARNESS, CODEX_HARNESS, HARNESSES } from '@factory/contracts';

import { readRunningPackages } from './running-packages.ts';
import type { RunningPackage } from './running-packages.ts';

export { listProviders, DEPLOYMENT_MODEL_PROVIDERS, isDeploymentModelProvider, resolveDeploymentModelProviders, buildProviderAccess, buildModelCatalog, listSessionScopedCredentials } from '@factory/credentials';
export type { ProviderCredentialSource, ProviderInfo, OMSession, ModelCatalog, ModelCredentialHolder, ModelCatalogEntry } from '@factory/credentials';

/** Absolute observation buffer @mastra/code-sdk reserves before a threshold can trigger. */
const MIN_OBSERVATION_BUFFER_TOKENS = 2000;

/** Widen a route-local Hono context to the plain `Context` the auth helpers take. */
function loose(c: unknown): Context {
  return c as Context;
}

/**
 * Server-side configuration routes for the web app.
 *
 * The browser has no access to the credential store or the model catalog, so
 * the web settings panel asks the server — which owns both — to list providers
 * and manage API keys. This mirrors the TUI's `/api-keys` command, exposing the
 * same `AuthStorage`-backed key management over HTTP.
 *
 * Keys are never returned to the client; only their presence and source.
 */

/** A user-defined OpenAI-compatible provider, with key presence (never the key). */
export interface CustomProviderInfo {
  id: string;
  name: string;
  url: string;
  hasApiKey: boolean;
  models: string[];
}

/** Redact a stored custom-provider row for the client (key presence only). */
function toCustomProviderInfo(record: CustomProviderRecord): CustomProviderInfo {
  return {
    id: record.providerId,
    name: record.name,
    url: record.url,
    hasApiKey: Boolean(record.apiKey),
    models: record.models,
  };
}

/** The resolved custom-providers storage scope for a request. */
interface CustomProvidersContext {
  storage: CustomProvidersStorage;
  orgId: string;
  userId: string;
}

/**
 * Resolve the custom-providers context for a request, or a ready-to-return
 * error response. Same posture as memory settings: tenant rows in deployed
 * mode, a sentinel `local` org in no-auth mode — never settings.json.
 */
async function resolveCustomProvidersContext({
  c,
  auth,
  customProviders,
}: {
  c: Context;
  auth: RouteAuth;
  customProviders?: CustomProvidersStorage;
}): Promise<CustomProvidersContext | { response: Response }> {
  await auth.ensureUser(c);
  const tenant = auth.tenant(c);
  if (!tenant && auth.enabled()) return { response: c.json({ error: 'unauthorized' }, 401) };
  if (customProviders) {
    try {
      await customProviders.ensureReady();
      return tenant
        ? { storage: customProviders, orgId: tenantOrgId(tenant), userId: tenant.userId }
        : { storage: customProviders, orgId: 'local', userId: 'local' };
    } catch {
      // fall through to the unavailable response
    }
  }
  return {
    response: c.json(
      {
        error: 'custom_providers_unavailable',
        message: 'Custom provider storage is unavailable — the app database is not configured or failed to start.',
      },
      503,
    ),
  };
}

/** Validate + coerce a request body into a CustomProviderSetting. */
function parseCustomProviderBody(body: unknown): CustomProviderSetting | { error: string } {
  if (!body || typeof body !== 'object') return { error: 'Invalid JSON body' };
  const b = body as Record<string, unknown>;
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name) return { error: 'Missing required field: name' };
  const url = typeof b.url === 'string' ? b.url.trim() : '';
  if (!url) return { error: 'Missing required field: url' };
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { error: 'url must be an http(s) URL' };
    }
  } catch {
    return { error: 'url must be a valid URL' };
  }
  const apiKey = typeof b.apiKey === 'string' && b.apiKey.trim() ? b.apiKey.trim() : undefined;
  const models = Array.isArray(b.models)
    ? b.models.filter((m): m is string => typeof m === 'string' && m.trim().length > 0).map(m => m.trim())
    : [];
  return { name, url, apiKey, models };
}

/** Per-user default model context for the current request. */
// Mirrors the TUI `/om` command. Settings are persisted per organization and
// user in the Factory app database, then loaded into request context for each
// invocation without copying them into mutable session state.

export interface OMRoleConfigInfo {
  model: 'auto' | string;
  effectiveModelId: string;
  effectiveModelSource: 'explicit' | 'live-session' | 'configured-default';
  providerStatus: 'available' | 'unavailable';
}

/** Persisted intent plus the concrete models the current Factory configuration resolves. */
export interface OMConfigInfo {
  observer: OMRoleConfigInfo;
  reflector: OMRoleConfigInfo;
  /** @deprecated Use `observer.effectiveModelId`. */
  observerModelId: string;
  /** @deprecated Use `reflector.effectiveModelId`. */
  reflectorModelId: string;
  observationThreshold: number;
  reflectionThreshold: number;
  observeAttachments: 'auto' | boolean;
}

export interface ProviderOMDefaultsResponse {
  ok: true;
  config: OMConfigInfo;
}

function modelProvider(modelId: string): string {
  // Effective IDs keep their `mastra/` route; the provider segment after it is what
  // the SDK resolver falls back to when the gateway is not configured.
  const normalized = modelId.replace(/^mastracode\//, '').replace(/^mastra\//, '');
  return normalized.split('/', 1)[0] ?? '';
}

function roleConfig(
  model: OMRoleConfigInfo['model'],
  effectiveModelId: string,
  autoModelSource: 'live-session' | 'configured-default',
  availableProviders: ReadonlySet<string>,
): OMRoleConfigInfo {
  return {
    model,
    effectiveModelId,
    effectiveModelSource: model === 'auto' ? autoModelSource : 'explicit',
    providerStatus:
      availableProviders.has(modelProvider(effectiveModelId)) ||
      (effectiveModelId.startsWith(MASTRA_GATEWAY_PREFIX) && availableProviders.has(MASTRA_GATEWAY_PROVIDER))
        ? 'available'
        : 'unavailable',
  };
}

function readStoredOMConfig(
  record: MemorySettingsRecord | null,
  currentModelId: string | undefined,
  autoModelSource: 'live-session' | 'configured-default',
  availableProviders: ReadonlySet<string>,
): OMConfigInfo {
  const autoModelId = resolveAutoOMModelId(currentModelId, providerId => availableProviders.has(providerId));
  const observerModelId = record?.observerModelId ?? autoModelId;
  const reflectorModelId = record?.reflectorModelId ?? autoModelId;
  return {
    observer: roleConfig(record?.observerModelId ?? 'auto', observerModelId, autoModelSource, availableProviders),
    reflector: roleConfig(record?.reflectorModelId ?? 'auto', reflectorModelId, autoModelSource, availableProviders),
    observerModelId,
    reflectorModelId,
    observationThreshold: record?.observationThreshold ?? DEFAULT_OBSERVATION_THRESHOLD,
    reflectionThreshold: record?.reflectionThreshold ?? DEFAULT_REFLECTION_THRESHOLD,
    observeAttachments: record?.observeAttachments ?? 'auto',
  };
}

/**
 * Where a request's OM settings live: the Factory's shared row in the
 * `memory-settings` factory storage domain. There are no personal memory
 * settings: rows an older build stored per user are never read or written.
 * Without a tenant (auth disabled) the Factory's row lives under the sentinel
 * `local` org — the web surface never reads or writes `settings.json`.
 */
interface MemorySettingsContext {
  storage: MemorySettingsStorage;
  orgId: string;
  userId: string;
}

/**
 * Resolve the memory-settings context for a request, or a ready-to-return
 * error response. The row addressed is the factory project's shared settings
 * (a sentinel user id in the caller's org) — what every session and run under
 * the Factory hydrates from. A request that names no Factory is refused.
 */
async function resolveMemorySettingsContext({
  c,
  auth,
  memorySettings,
  factoryProjectId,
  factoryProjects,
}: {
  c: Context;
  auth: RouteAuth;
  memorySettings?: MemorySettingsStorage;
  factoryProjectId?: string;
  factoryProjects?: FactoryProjectsStorage;
}): Promise<MemorySettingsContext | { response: Response }> {
  await auth.ensureUser(c);
  const tenant = auth.tenant(c);
  if (!tenant && auth.enabled()) return { response: c.json({ error: 'unauthorized' }, 401) };
  if (!factoryProjectId) return { response: c.json({ error: 'factory_id_required' }, 400) };
  // Factory-scoped rows are shared org state: the target project must exist in
  // the caller's org before its settings row can be read or written.
  if (tenant) {
    if (!factoryProjects) return { response: c.json({ error: 'factory_unavailable' }, 503) };
    try {
      await factoryProjects.ensureReady();
      const project = await factoryProjects.get({ orgId: tenantOrgId(tenant), id: factoryProjectId });
      if (!project) return { response: c.json({ error: 'factory_project_not_found' }, 404) };
    } catch {
      return { response: c.json({ error: 'factory_unavailable' }, 503) };
    }
  }
  if (memorySettings) {
    try {
      await memorySettings.ensureReady();
      const userId = factoryMemorySettingsUserId(factoryProjectId);
      return { storage: memorySettings, orgId: tenant ? tenantOrgId(tenant) : 'local', userId };
    } catch {
      // fall through to the unavailable response
    }
  }
  return {
    response: c.json(
      {
        error: 'memory_settings_unavailable',
        message: 'Memory settings storage is unavailable — the app database is not configured or failed to start.',
      },
      503,
    ),
  };
}

/** Persist an OM knob change to the Factory's memory-settings row. */
async function persistMemorySettings(context: MemorySettingsContext, patch: MemorySettingsPatch): Promise<void> {
  await context.storage.patch({ orgId: context.orgId, userId: context.userId, patch });
}

/** Dependencies injected into {@link ConfigRoutes}. */
export interface ConfigRoutesDeps extends RouteDependencies {
  controller: ModelCatalog;
  /**
   * `mcp`: the Factory MCP endpoint is mounted (auth plus an MCP authorization server).
   * `claudeSignIn`: a person can sign in to Claude from the settings, the CLI's browser page opening on
   * this machine (see `CredentialAccountRoutes`).
   * `codexSignIn`: a person can sign in to ChatGPT for Codex from the settings, the CLI's browser page
   * opening on this machine, as for `claudeSignIn`.
   */
  features?: {
    knowledge: boolean;
    mcp?: boolean;
    claudeCode?: boolean;
    claudeSignIn?: boolean;
    codex?: boolean;
    codexSignIn?: boolean;
    device?: boolean;
  };
  /** Reads the Mastra packages this server runs; defaults to the build manifest. */
  readPackages?: () => Promise<RunningPackage[]>;
  authStorage?: AuthStorage;
  /** Tenant credential domain handle; absent in local (no-DB) mode. */
  modelCredentials?: ModelCredentialsStorage;
  /** Source-control sessions available to config route integrations. */
  sourceControlSessions?: Pick<SourceControlStorageHandle['sessions'], 'getBySessionId'>;
  sourceControls?: Array<Pick<SourceControlStorageHandle, 'sessions'>>;
  /** Thread membership used to resolve the same model policy as an invocation. */
  workItems?: WorkItemsStorage;
  /** Tenant memory-settings domain handle; absent in local (no-DB) mode. */
  memorySettings?: MemorySettingsStorage;
  /** Factory projects domain, used to derive OM fallbacks from a factory's default model. */
  factoryProjects?: FactoryProjectsStorage;
  /** Custom-providers domain handle; absent when the app database is missing. */
  customProviders?: CustomProvidersStorage;
  /** Notifies the host after tenant credentials change so caches can be dropped. */
  onCredentialsChanged?: (tenant: { orgId: string; userId?: string }) => void;
  /** Notifies the host after custom providers change so model-router caches can be dropped. */
  onCustomProvidersChanged?: (tenant: { orgId: string }) => void;
  /**
   * Tenant mode: providers the operator opted in to run on the server process's
   * own credentials (see `DEPLOYMENT_MODEL_PROVIDERS`).
   */
  deploymentProviders?: ReadonlySet<string>;
  /**
   * The server's harness model registry: every harness's instance, with its catalog, lands in
   * `/web/config/models` `instances` (Mastra's from the catalog this route resolves). Absent: Mastra's alone.
   */
  harnessModels?: () => Pick<HarnessModelRegistry, 'describe' | 'forInstance'> | undefined;
}

/** `GET /web/config/models`: Mastra's catalog (`models`, kept for the Settings pickers) and every harness instance. */
export interface ModelCatalogResponseBody {
  models: ModelCatalogEntry[];
  /** The session's Factory default (session query). */
  defaultModelId?: string | null;
  /** The model a chat starts on while the Factory has no default (factory query). */
  fallbackModelId?: string | null;
  /** One per harness this server runs, Mastra's first-class like any other: what the model picker reads. */
  instances: HarnessModelInstanceInfo[];
}

/**
 * The web config routes as Mastra `apiRoutes`:
 *   - `GET    /web/config/features`               — list server-enabled product features
 *   - `GET    /web/config/versions`               — list the Mastra packages and Node version this server runs
 *   - `GET    /web/config/providers`              — list providers + key source
 *   - `PUT    /web/config/providers/:provider/key` — set/update a provider's API key
 *   - `DELETE /web/config/providers/:provider/key` — remove a stored API key
 *   - `GET    /web/config/models`                  — list available models (credentialed providers) with their
 *                                                   option descriptors, and the Claude Code catalog
 *   - `GET    /web/config/custom-providers`        — list custom OpenAI-compatible providers
 *   - `POST   /web/config/custom-providers`        — create/update a custom provider
 *   - `DELETE /web/config/custom-providers/:id`    — remove a custom provider
 *   - `GET    /web/config/om`                      — read OM models/thresholds/observe-attachments
 *   - `PUT    /web/config/om/:role/model`          — switch observer/reflector model
 *   - `PUT    /web/config/om/thresholds`           — set observation/reflection thresholds
 *   - `PUT    /web/config/om/observe-attachments`  — set observe-attachments (auto/on/off)
 */
export class ConfigRoutes extends Route<ConfigRoutesDeps> {
  routes(): ApiRoute[] {
    const options = this.deps;
    const { controller, authStorage, auth, deploymentProviders } = options;
    const onCredentialsChanged = options.onCredentialsChanged ?? (() => {});
    const onCustomProvidersChanged = options.onCustomProvidersChanged ?? (() => {});
    // Every harness's instance: Mastra's from the catalog this route resolved, the others from their facets.
    const withInstances = async (
      body: Omit<ModelCatalogResponseBody, 'instances'>,
      ctx: HarnessModelContext,
    ): Promise<ModelCatalogResponseBody> => {
      const registry = options.harnessModels?.();
      const mastraFacet = registry?.forInstance(MASTRA_INSTANCE_ID);
      // Mastra's instance from the catalog this route resolved; its defaults as every facet reports them.
      const mastra = mastraModelInstance(body.models, {
        factoryDefault: mastraFacet?.factoryDefault ? await mastraFacet.factoryDefault(ctx) : await storedMastraDefault(ctx),
        catalogDefaultModelId:
          body.fallbackModelId ?? controller.getDefaultMode?.().defaultModelId ?? null,
        appliesToRunningSessions: mastraFacet?.applyDefaultToRunningSessions !== undefined,
      });
      const instances = registry ? await registry.describe(ctx, [mastra]) : [mastra];
      return { ...body, instances };
    };
    // A server without the Mastra facet registered (tests, a bare config server) reads the store itself.
    const storedMastraDefault = async (ctx: HarnessModelContext) => {
      if (!ctx.factoryProjectId || !options.factoryProjects) return null;
      const project = await options.factoryProjects.getById({ id: ctx.factoryProjectId }).catch(() => null);
      if (!project || (ctx.viewer.orgId && project.orgId !== ctx.viewer.orgId)) return null;
      return project.harnessModelDefaults[MASTRA_INSTANCE_ID] ?? null;
    };

    const resolveOMResponseContext = async (c: Context) => {
      const tenantCredentials = await listTenantCredentialsForRequest({
        c: loose(c),
        auth,
        credentials: options.modelCredentials,
      });
      const access = await buildProviderAccess({
        controller,
        authStorage: tenantCredentials ? undefined : authStorage,
        tenantCredentials,
        deploymentProviders,
      });
      const availableProviders = new Set(
        Object.entries(access).flatMap(([providerId, configured]) => (configured ? [providerId] : [])),
      );
      // `mastra/` routes run through the Mastra gateway whenever its key is configured.
      if (MastraCodeGateway.getMastraGatewayApiKey()) availableProviders.add(MASTRA_GATEWAY_PROVIDER);
      if (options.customProviders) {
        const context = await resolveCustomProvidersContext({
          c: loose(c),
          auth,
          customProviders: options.customProviders,
        });
        if (!('response' in context)) {
          for (const provider of await context.storage.list({ orgId: context.orgId })) {
            availableProviders.add(provider.providerId);
          }
        }
      }
      return availableProviders;
    };

    // Without a live session, Auto previews against the factory default model
    // (resolved with this account's providers in readStoredOMConfig), then the
    // server's mode default when the Factory has none.
    const factoryOmFallback = async (factoryProjectId: string | undefined): Promise<string | undefined> => {
      const modeDefault = () => controller.listModes?.().find(mode => mode.defaultModelId)?.defaultModelId;
      try {
        const project = factoryProjectId ? await options.factoryProjects?.getById({ id: factoryProjectId }) : undefined;
        return project?.defaultModelId ?? modeDefault();
      } catch {
        return undefined;
      }
    };

    return [
      registerApiRoute('/web/config/features', {
        method: 'GET',
        requiresAuth: false,
        handler: async c =>
          c.json({
            knowledge: options.features?.knowledge ?? false,
            mcp: options.features?.mcp ?? false,
            claudeCode: options.features?.claudeCode ?? false,
            claudeSignIn: (options.features?.claudeCode ?? false) && (options.features?.claudeSignIn ?? false),
            codex: options.features?.codex ?? false,
            codexSignIn: (options.features?.codex ?? false) && (options.features?.codexSignIn ?? false),
            device: options.features?.device ?? false,
            // What each harness this server runs can do; the UI asks these instead of checking ids.
            harnesses: HARNESSES.filter(
              harness =>
                (harness.id !== CLAUDE_CODE_HARNESS.id || options.features?.claudeCode === true) &&
                (harness.id !== CODEX_HARNESS.id || options.features?.codex === true),
            ),
          }),
      }),

      registerApiRoute('/web/config/versions', {
        method: 'GET',
        requiresAuth: false,
        handler: async c => {
          await auth.ensureUser(loose(c));
          if (!auth.tenant(loose(c)) && auth.enabled()) return c.json({ error: 'unauthorized' }, 401);
          const packages = await (options.readPackages ?? readRunningPackages)();
          return c.json({ packages, nodeVersion: process.version });
        },
      }),

      registerApiRoute('/web/config/providers', {
        method: 'GET',
        requiresAuth: false,
        handler: async c => {
          try {
            // Tenant mode lists the organization's rows and never exposes the
            // server-global auth.json; local mode is unchanged.
            const tenantCredentials = await listTenantCredentialsForRequest({
              c: loose(c),
              auth,
              credentials: options.modelCredentials,
            });
            // Tenant mode also reports whether the caller may write the
            // organization's keys, so the settings UI can gate editing.
            const tenant = auth.tenant(loose(c));
            const orgKeyAdmin = tenant ? await auth.isOrganizationAdmin(loose(c), tenantOrgId(tenant)) : undefined;
            return c.json({
              providers: await listProviders({
                controller,
                authStorage: tenantCredentials ? undefined : authStorage,
                tenantCredentials,
                deploymentProviders,
              }),
              ...(orgKeyAdmin !== undefined ? { orgKeyAdmin } : {}),
            });
          } catch (error) {
            return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
          }
        },
      }),

      registerApiRoute('/web/config/providers/:provider/key', {
        method: 'PUT',
        requiresAuth: false,
        handler: async c => {
          const ctx = await resolveCredentialContext({ c: loose(c), auth, credentials: options.modelCredentials });
          if ('response' in ctx) return ctx.response;

          const provider = c.req.param('provider');
          let body: { key?: unknown; envVar?: unknown };
          try {
            body = await c.req.json();
          } catch {
            return c.json({ error: 'Invalid JSON body' }, 400);
          }
          const key = typeof body.key === 'string' ? body.key.trim() : '';
          if (!key) return c.json({ error: 'Missing required field: key' }, 400);
          const envVar = typeof body.envVar === 'string' ? body.envVar : undefined;
          try {
            if (ctx.mode === 'tenant') {
              // A stored key would never be read: these providers authenticate
              // with the server process's credentials only.
              if (isDeploymentModelProvider(provider)) {
                return c.json(
                  {
                    error: 'provider_configured_by_deployment',
                    message: `${provider} is configured by the Factory deployment (credentials on the server), not per account.`,
                  },
                  400,
                );
              }
              // Model keys belong to the organization; there are no personal keys.
              if (!(await auth.isOrganizationAdmin(loose(c), ctx.orgId))) {
                return c.json({ error: 'organization_admin_required' }, 403);
              }
              const tenant = { orgId: ctx.orgId };
              // envVar is intentionally ignored: tenant credentials are resolved
              // per-request, never written into process.env.
              await ctx.storage.setCredential(tenant, getAuthProviderId(provider), { type: 'api_key', key });
              onCredentialsChanged(tenant);
              const records = (await ctx.storage.listCredentials(ctx.orgId, ctx.userId)).filter(
                record => record.scope === 'org',
              );
              const providers = await listProviders({ controller, tenantCredentials: records, deploymentProviders });
              return c.json({ ok: true, provider: providers.find(p => p.provider === provider) });
            }
            if (!authStorage) return c.json({ error: 'Credential storage is not available' }, 503);
            authStorage.setStoredApiKey(provider, key, envVar);
            const providers = await listProviders({ controller, authStorage });
            return c.json({ ok: true, provider: providers.find(p => p.provider === provider) });
          } catch (error) {
            return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
          }
        },
      }),

      registerApiRoute('/web/config/providers/:provider/key', {
        method: 'DELETE',
        requiresAuth: false,
        handler: async c => {
          const ctx = await resolveCredentialContext({ c: loose(c), auth, credentials: options.modelCredentials });
          if ('response' in ctx) return ctx.response;

          const provider = c.req.param('provider');
          try {
            if (ctx.mode === 'tenant') {
              if (!(await auth.isOrganizationAdmin(loose(c), ctx.orgId))) {
                return c.json({ error: 'organization_admin_required' }, 403);
              }
              const tenant = { orgId: ctx.orgId };
              await ctx.storage.removeCredential(tenant, getAuthProviderId(provider));
              onCredentialsChanged(tenant);
              const records = (await ctx.storage.listCredentials(ctx.orgId, ctx.userId)).filter(
                record => record.scope === 'org',
              );
              const providers = await listProviders({ controller, tenantCredentials: records, deploymentProviders });
              return c.json({ ok: true, provider: providers.find(p => p.provider === provider) });
            }
            if (!authStorage) return c.json({ error: 'Credential storage is not available' }, 503);
            authStorage.remove(`apikey:${provider}`);
            const providers = await listProviders({ controller, authStorage });
            return c.json({ ok: true, provider: providers.find(p => p.provider === provider) });
          } catch (error) {
            return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
          }
        },
      }),

      // Mirrors the TUI's /custom-providers command, but backed by the
      // `custom-providers` domain (org rows in tenant mode, a sentinel `local`
      // org in no-auth mode) — the server never reads settings.json for these.

      registerApiRoute('/web/config/custom-providers', {
        method: 'GET',
        requiresAuth: false,
        handler: async c => {
          const ctx = await resolveCustomProvidersContext({
            c: loose(c),
            auth,
            customProviders: options.customProviders,
          });
          if ('response' in ctx) return ctx.response;
          try {
            const records = await ctx.storage.list({ orgId: ctx.orgId });
            return c.json({ providers: records.map(toCustomProviderInfo) });
          } catch (error) {
            return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
          }
        },
      }),

      registerApiRoute('/web/config/custom-providers', {
        method: 'POST',
        requiresAuth: false,
        handler: async c => {
          const ctx = await resolveCustomProvidersContext({
            c: loose(c),
            auth,
            customProviders: options.customProviders,
          });
          if ('response' in ctx) return ctx.response;
          let body: unknown;
          try {
            body = await c.req.json();
          } catch {
            return c.json({ error: 'Invalid JSON body' }, 400);
          }
          const parsed = parseCustomProviderBody(body);
          if ('error' in parsed) return c.json({ error: parsed.error }, 400);
          // `previousId` lets a rename remove the old entry as well as any name clash.
          const previousId =
            body && typeof body === 'object' && typeof (body as Record<string, unknown>).previousId === 'string'
              ? ((body as Record<string, unknown>).previousId as string)
              : undefined;
          try {
            const record = await ctx.storage.upsert({
              orgId: ctx.orgId,
              userId: ctx.userId,
              input: {
                providerId: getCustomProviderId(parsed.name),
                name: parsed.name,
                url: parsed.url,
                apiKey: parsed.apiKey,
                models: parsed.models,
              },
              previousProviderId: previousId,
            });
            onCustomProvidersChanged({ orgId: ctx.orgId });
            return c.json({ ok: true, provider: toCustomProviderInfo(record) });
          } catch (error) {
            return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
          }
        },
      }),

      registerApiRoute('/web/config/custom-providers/:id', {
        method: 'DELETE',
        requiresAuth: false,
        handler: async c => {
          const ctx = await resolveCustomProvidersContext({
            c: loose(c),
            auth,
            customProviders: options.customProviders,
          });
          if ('response' in ctx) return ctx.response;
          const id = c.req.param('id');
          try {
            await ctx.storage.delete({ orgId: ctx.orgId, providerId: id });
            onCustomProvidersChanged({ orgId: ctx.orgId });
            return c.json({ ok: true });
          } catch (error) {
            return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
          }
        },
      }),

      // Session-independent model catalog for settings pickers (Factory default
      // model, pack editors). Only models whose provider has a credential are
      // returned — the same filter the session-scoped hook applies client-side.

      registerApiRoute('/web/config/models', {
        method: 'GET',
        requiresAuth: false,
        handler: async c => {
          try {
            const allTenantCredentials = await listTenantCredentialsForRequest({
              c: loose(c),
              auth,
              credentials: options.modelCredentials,
            });
            const tenant = auth.tenant(c);
            let tenantCredentials = allTenantCredentials;
            let sessionPolicy: { defaultModelId: string | null } | undefined;
            let sessionFactoryProjectId: string | undefined;
            const resourceId = c.req.query('resourceId');
            const threadId = c.req.query('threadId');
            const sessionId = c.req.query('sessionId');
            if (resourceId !== undefined || threadId !== undefined || sessionId !== undefined) {
              // A caller that names no session addresses it by the resource, which is
              // the session id for sessions that run under their own resource.
              const address = z
                .object({
                  resourceId: z.string().trim().min(1),
                  threadId: z.string().trim().min(1),
                  sessionId: z.string().trim().min(1).optional(),
                })
                .transform(data => ({ ...data, sessionId: data.sessionId ?? data.resourceId }))
                .safeParse({ resourceId, threadId, sessionId });
              if (!address.success) return c.json({ error: 'invalid_session_context' }, 400);
              if (!tenant && auth.enabled()) return c.json({ error: 'unauthorized' }, 401);
              if (tenant) {
                if (
                  !options.factoryProjects ||
                  !options.sourceControlSessions ||
                  !options.workItems ||
                  !options.modelCredentials
                )
                  return c.json({ error: 'session_model_policy_unavailable' }, 503);
                const requestContext = new RequestContext();
                requestContext.set('user', { id: tenant.userId, organizationId: tenantOrgId(tenant) });
                requestContext.set('controller', address.data);
                let policy;
                try {
                  policy = await resolveFactoryModelPolicy(requestContext, {
                    projects: options.factoryProjects,
                    sourceControl: options.sourceControlSessions,
                    workItems: options.workItems,
                  });
                } catch {
                  return c.json({ error: 'session_model_policy_unavailable' }, 403);
                }
                if (!policy) return c.json({ error: 'unauthorized' }, 401);
                tenantCredentials = await listSessionScopedCredentials({
                  credentials: options.modelCredentials,
                  orgId: policy.tenant.orgId ?? tenantOrgId(tenant),
                  userId: policy.tenant.userId,
                });
                sessionPolicy = { defaultModelId: policy.factoryDefaultModelId ?? null };
                sessionFactoryProjectId = policy.factoryProjectId;
              }
            }
            const customProviders = options.customProviders;
            const listCustomProviders = customProviders
              ? async () => {
                  const ctx = await resolveCustomProvidersContext({ c: loose(c), auth, customProviders });
                  return 'response' in ctx ? [] : ctx.storage.list({ orgId: ctx.orgId });
                }
              : undefined;
            const models = await buildModelCatalog({
              controller,
              authStorage,
              tenantCredentials,
              deploymentProviders,
              listCustomProviders,
            });
            const viewer = { userId: tenant?.userId ?? '', orgId: tenant ? tenantOrgId(tenant) : '' };
            // A session answers for its own Factory, whose defaults its harness follows.
            const factoryProjectId = sessionFactoryProjectId ?? (c.req.query('factoryId') || undefined);
            const harnessContext: HarnessModelContext = {
              viewer,
              ...(sessionId ?? resourceId ? { sessionId: sessionId ?? resourceId } : {}),
              ...(factoryProjectId ? { factoryProjectId } : {}),
            };
            if (sessionPolicy || !tenant || !factoryProjectId)
              return c.json(await withInstances({ ...sessionPolicy, models }, harnessContext));
            // A Factory's own catalog, outside any session. Name the model a chat starts on when the
            // Factory has no default, the same pick session hydration makes; null when no key runs it.
            const modeModelId = controller.getDefaultMode?.().defaultModelId;
            const candidate =
              (await resolveTenantProviderDefaultModel(
                { orgId: tenantOrgId(tenant), userId: tenant.userId, credentialScope: 'factory' },
                modeModelId,
              ).catch(error => {
                console.warn('[Factory Config] Failed to resolve a provider default model', {
                  error: error instanceof Error ? error.message : String(error),
                });
                return undefined;
              })) ?? modeModelId;
            const fallbackModelId = models.find(model => model.id === candidate)?.id ?? null;
            return c.json(await withInstances({ fallbackModelId, models }, harnessContext));
          } catch (error) {
            return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
          }
        },
      }),

      // Mirrors the TUI's /om command. All five knobs are durably stored on the
      // Factory's row of the `memory-settings` app table — never settings.json or
      // mutable session state.

      registerApiRoute('/web/config/om', {
        method: 'GET',
        requiresAuth: false,
        handler: async c => {
          const sessionId = c.req.query('sessionId');
          const factoryProjectId = c.req.query('factoryId') || undefined;
          const context = await resolveMemorySettingsContext({
            c: loose(c),
            auth,
            memorySettings: options.memorySettings,
            factoryProjectId,
            factoryProjects: options.factoryProjects,
          });
          if ('response' in context) return context.response;
          try {
            const record = await context.storage.get({ orgId: context.orgId, userId: context.userId });
            const fallback = await factoryOmFallback(factoryProjectId);
            const availableProviders = await resolveOMResponseContext(loose(c));
            const session = sessionId ? await controller.getSession?.(sessionId) : undefined;
            const sessionModelId = session?.model.get();
            return c.json({
              config: readStoredOMConfig(
                record,
                sessionModelId || fallback,
                sessionModelId ? 'live-session' : 'configured-default',
                availableProviders,
              ),
            });
          } catch (error) {
            return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
          }
        },
      }),

      registerApiRoute('/web/config/om/:role/model', {
        method: 'PUT',
        requiresAuth: false,
        handler: async c => {
          const role = c.req.param('role');
          if (role !== 'observer' && role !== 'reflector') {
            return c.json({ error: `Unknown OM role "${role}"` }, 400);
          }
          let body: { sessionId?: unknown; modelId?: unknown; factoryId?: unknown };
          try {
            body = await c.req.json();
          } catch {
            return c.json({ error: 'Invalid JSON body' }, 400);
          }
          const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
          const factoryProjectId = typeof body.factoryId === 'string' && body.factoryId ? body.factoryId : undefined;
          const model = typeof body.modelId === 'string' ? body.modelId.trim() : '';
          if (!model) {
            return c.json({ error: 'Missing required field: modelId' }, 400);
          }
          // `'auto'` is selection intent, not a model ID: store null so the role
          // follows the active main model instead of pinning a model named "auto".
          const wantsAuto = model === 'auto';
          const context = await resolveMemorySettingsContext({
            c: loose(c),
            auth,
            memorySettings: options.memorySettings,
            factoryProjectId,
            factoryProjects: options.factoryProjects,
          });
          if ('response' in context) return context.response;
          // Resolve the response context before persisting: a provider-enumeration
          // failure must not report 500 for a write that already succeeded.
          const availableProviders = await resolveOMResponseContext(loose(c));
          try {
            await persistMemorySettings(context, {
              [role === 'observer' ? 'observerModelId' : 'reflectorModelId']: wantsAuto ? null : model,
            });
            const record = await context.storage.get({ orgId: context.orgId, userId: context.userId });
            const session = sessionId ? await controller.getSession?.(sessionId) : undefined;
            const sessionModelId = session?.model.get();
            const config = readStoredOMConfig(
              record,
              sessionModelId || (await factoryOmFallback(factoryProjectId)),
              sessionModelId ? 'live-session' : 'configured-default',
              availableProviders,
            );
            return c.json({ ok: true, config });
          } catch (error) {
            return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
          }
        },
      }),

      registerApiRoute('/web/config/om/thresholds', {
        method: 'PUT',
        requiresAuth: false,
        handler: async c => {
          let body: {
            sessionId?: unknown;
            observationThreshold?: unknown;
            reflectionThreshold?: unknown;
            factoryId?: unknown;
          };
          try {
            body = await c.req.json();
          } catch {
            return c.json({ error: 'Invalid JSON body' }, 400);
          }
          const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
          const factoryProjectId = typeof body.factoryId === 'string' && body.factoryId ? body.factoryId : undefined;
          const observation =
            typeof body.observationThreshold === 'number' && body.observationThreshold > 0
              ? Math.round(body.observationThreshold)
              : undefined;
          const reflection =
            typeof body.reflectionThreshold === 'number' && body.reflectionThreshold > 0
              ? Math.round(body.reflectionThreshold)
              : undefined;
          if (observation === undefined && reflection === undefined) {
            return c.json({ error: 'Provide observationThreshold and/or reflectionThreshold (positive numbers)' }, 400);
          }
          // Observation keeps an absolute 2000-token buffer, and a threshold at or below it
          // makes every turn throw outside a request handler, which takes the whole server down.
          if (observation !== undefined && observation <= MIN_OBSERVATION_BUFFER_TOKENS) {
            return c.json(
              { error: `observationThreshold must be greater than ${MIN_OBSERVATION_BUFFER_TOKENS} tokens` },
              400,
            );
          }
          const context = await resolveMemorySettingsContext({
            c: loose(c),
            auth,
            memorySettings: options.memorySettings,
            factoryProjectId,
            factoryProjects: options.factoryProjects,
          });
          if ('response' in context) return context.response;
          const availableProviders = await resolveOMResponseContext(loose(c));
          try {
            await persistMemorySettings(context, {
              ...(observation !== undefined ? { observationThreshold: observation } : {}),
              ...(reflection !== undefined ? { reflectionThreshold: reflection } : {}),
            });
            const record = await context.storage.get({ orgId: context.orgId, userId: context.userId });
            const session = sessionId ? await controller.getSession?.(sessionId) : undefined;
            const sessionModelId = session?.model.get();
            const config = readStoredOMConfig(
              record,
              sessionModelId || (await factoryOmFallback(factoryProjectId)),
              sessionModelId ? 'live-session' : 'configured-default',
              availableProviders,
            );
            return c.json({ ok: true, config });
          } catch (error) {
            return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
          }
        },
      }),

      registerApiRoute('/web/config/om/observe-attachments', {
        method: 'PUT',
        requiresAuth: false,
        handler: async c => {
          let body: { sessionId?: unknown; value?: unknown; factoryId?: unknown };
          try {
            body = await c.req.json();
          } catch {
            return c.json({ error: 'Invalid JSON body' }, 400);
          }
          const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
          const factoryProjectId = typeof body.factoryId === 'string' && body.factoryId ? body.factoryId : undefined;
          const raw = body.value;
          const value: 'auto' | boolean = raw === 'auto' || raw === true || raw === false ? raw : 'auto';
          if (raw !== 'auto' && raw !== true && raw !== false) {
            return c.json({ error: "value must be 'auto', true, or false" }, 400);
          }
          const context = await resolveMemorySettingsContext({
            c: loose(c),
            auth,
            memorySettings: options.memorySettings,
            factoryProjectId,
            factoryProjects: options.factoryProjects,
          });
          if ('response' in context) return context.response;
          const availableProviders = await resolveOMResponseContext(loose(c));
          try {
            await persistMemorySettings(context, { observeAttachments: value });
            const record = await context.storage.get({ orgId: context.orgId, userId: context.userId });
            const session = sessionId ? await controller.getSession?.(sessionId) : undefined;
            const sessionModelId = session?.model.get();
            const config = readStoredOMConfig(
              record,
              sessionModelId || (await factoryOmFallback(factoryProjectId)),
              sessionModelId ? 'live-session' : 'configured-default',
              availableProviders,
            );
            return c.json({ ok: true, config });
          } catch (error) {
            return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
          }
        },
      }),
    ];
  }
}
