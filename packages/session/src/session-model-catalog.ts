import type { AuthStorage } from '@mastra/code-sdk/auth/storage';
import { RequestContext } from '@mastra/core/request-context';

import { buildModelCatalog, listSessionScopedCredentials } from '@factory/credentials';
import type { ModelCatalogEntry } from '@factory/credentials';
import type { CustomProvidersStorage, FactoryProjectsStorage, ModelCredentialsStorage, WorkItemsStorage } from '@factory/store';
import { resolveFactoryModelPolicy } from './credential-policy.ts';
import type { SourceControlSessionLookup } from './factory-session.ts';

/** Where a session's model catalog comes from; the agent tool and the chat's model switch share it. */
export interface SessionModelCatalogDependencies {
  projects: Pick<FactoryProjectsStorage, 'getById'>;
  sourceControl: Pick<SourceControlSessionLookup, 'getBySessionId'>;
  workItems: Pick<WorkItemsStorage, 'findRunBindingByThread'>;
  /**
   * The server's local credential store (`auth.json`), as `/web/config/models` reads it. Without
   * tenant credentials it decides which providers run, with the server's own keys.
   */
  authStorage?: () => AuthStorage | undefined;
  /**
   * Tenant credential stores, present when auth is on. Model switches then
   * check the target session's credential scope, like the Settings picker.
   */
  tenantCatalog?: {
    credentials: Pick<ModelCredentialsStorage, 'listCredentials'>;
    customProviders?: Pick<CustomProvidersStorage, 'ensureReady' | 'list'>;
    deploymentProviders?: ReadonlySet<string>;
  };
}

/** The models a session can run: `usable` ids, every id the server `known`s, and whose credentials decided. */
export interface SessionModelCatalog {
  models: ModelCatalogEntry[];
  usable: string[];
  known: Set<string>;
  scopeLabel: 'server' | 'Factory';
}

type CatalogController = Parameters<typeof buildModelCatalog>[0]['controller'];

/**
 * The models a session can switch to, resolved from its owner and its Factory's policy: the same
 * `buildModelCatalog` the Settings picker (`/web/config/models`) runs, so they cannot drift.
 */
export async function resolveSessionModelCatalog(
  controller: CatalogController,
  session: { sessionId: string; threadId: string; resourceId: string },
  viewer: { userId: string; orgId: string },
  deps: SessionModelCatalogDependencies,
): Promise<SessionModelCatalog> {
  const available = await controller.listAvailableModels();
  const known = new Set(available.flatMap(model => (typeof model.id === 'string' ? [model.id] : [])));
  const authStorage = deps.authStorage?.();
  const tenantCatalog = deps.tenantCatalog;
  if (!tenantCatalog) {
    const models = await buildModelCatalog({ controller, ...(authStorage ? { authStorage } : {}) });
    return { models, usable: models.map(model => model.id), known, scopeLabel: 'server' };
  }
  const requestContext = new RequestContext();
  requestContext.set('user', { id: viewer.userId, organizationId: viewer.orgId });
  requestContext.set('controller', session);
  const policy = await resolveFactoryModelPolicy(requestContext, {
    projects: deps.projects,
    sourceControl: deps.sourceControl,
    workItems: deps.workItems,
  });
  if (!policy) throw new Error('Session model policy is unavailable.');
  const orgId = policy.tenant.orgId ?? viewer.orgId;
  const customProviders = tenantCatalog.customProviders;
  const models = await buildModelCatalog({
    controller,
    ...(authStorage ? { authStorage } : {}),
    tenantCredentials: await listSessionScopedCredentials({
      credentials: tenantCatalog.credentials,
      orgId,
      userId: policy.tenant.userId,
    }),
    deploymentProviders: tenantCatalog.deploymentProviders,
    listCustomProviders: customProviders
      ? async () => {
          await customProviders.ensureReady();
          return customProviders.list({ orgId });
        }
      : undefined,
  });
  for (const model of models) known.add(model.id);
  return { models, usable: models.map(model => model.id), known, scopeLabel: 'Factory' };
}

const LISTED_MODELS = 8;

/** Why a session cannot run `modelId`: unknown, or known but without a credential in its scope. */
export function unrunnableModelMessage(modelId: string, catalog: Pick<SessionModelCatalog, 'usable' | 'known' | 'scopeLabel'>): string {
  const options = catalog.usable.length
    ? ` Models available to it: ${catalog.usable.slice(0, LISTED_MODELS).join(', ')}${catalog.usable.length > LISTED_MODELS ? ', …' : ''}.`
    : ' No models are available to it; connect a provider credential first.';
  return catalog.known.has(modelId)
    ? `Model ${modelId} exists, but this session's credential scope (${catalog.scopeLabel}) has no credential for its provider.${options}`
    : `Unknown model ${modelId}.${options}`;
}
