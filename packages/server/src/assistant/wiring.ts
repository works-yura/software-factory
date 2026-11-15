/**
 * «Помічник» on the Factory server (ADR-0051): the assistant's ports filled from the server's own
 * pieces — the shared blob store, the encryption envelope, the organization's model credentials,
 * Mastra memory storage, the audit log, the auth provider's removal hooks — and Factory reached
 * only through its MCP endpoint, over HTTP, with the person's OAuth token.
 */
import {
  AssistantError,
  AssistantService,
  buildAssistantRoutes,
  createAssistantMemory,
  createAssistantMemoryEraser,
  createMastraAssistantBrain,
  FactoryAccess,
  McpFactoryClient,
  startAssistantRetention,
} from '@factory/assistant-core';
import type { AssistantModelResolver, AssistantModels, AssistantStorage, RetentionJob } from '@factory/assistant-core';
import {
  buildModelCatalog,
  listSessionScopedCredentials,
  primeTenantCredentialsForRequestContext,
  resolveTenantProviderDefaultModel,
} from '@factory/credentials';
import type { ModelCatalog } from '@factory/credentials';
import type { RouteAuth } from '@factory/http';
import type {
  AttachmentBlobStore,
  AuditStorage,
  CustomProvidersStorage,
  FactorySecretEncryption,
  ModelCredentialsStorage,
} from '@factory/store';
import { resolveModel } from '@mastra/code-sdk/agents/model';
import { RequestContext } from '@mastra/core/request-context';
import type { ApiRoute } from '@mastra/core/server';
import type { MastraCompositeStore } from '@mastra/core/storage';

/** The auth provider's hooks the assistant's cleanup listens to (`@factory/auth-better-auth`). */
interface RemovalHooks {
  onMemberRemoved(listener: (organizationId: string, userId: string) => Promise<void>): void;
  onUserDeleted(listener: (userId: string) => Promise<void>): void;
}

function hasRemovalHooks(provider: unknown): provider is RemovalHooks {
  const candidate = provider as Partial<RemovalHooks> | undefined;
  return typeof candidate?.onMemberRemoved === 'function' && typeof candidate.onUserDeleted === 'function';
}

function authorizationServerOf(provider: unknown): ((request: Request) => Promise<Response>) | undefined {
  const candidate = provider as { handleAuthRequest?: (request: Request) => Promise<Response> } | undefined;
  return typeof candidate?.handleAuthRequest === 'function' ? request => candidate.handleAuthRequest!(request) : undefined;
}

export interface FactoryAssistantOptions {
  storage: AssistantStorage;
  mastraStorage: MastraCompositeStore;
  secretEncryption: FactorySecretEncryption;
  /** The attachment blob store; without one, requests take text only and say why files are refused. */
  blobs?: AttachmentBlobStore;
  /** Whether bytes are still named by a Factory attachment (or anything else that shares the store). */
  blobReferencedElsewhere: (sha256: string) => Promise<boolean>;
  modelCredentials: ModelCredentialsStorage;
  customProviders?: CustomProvidersStorage;
  deploymentProviders: ReadonlySet<string>;
  audit: AuditStorage;
  publicOrigin: string;
  /** The auth provider: its authorization server for the assistant's OAuth grant, its removal hooks. */
  authProvider: unknown;
}

export interface FactoryAssistant {
  service: AssistantService;
  /** The routes, once the server's model catalog (the agent controller) is known. */
  routes(input: { auth: RouteAuth; controller: ModelCatalog }): ApiRoute[];
  stop(): void;
}

export function createFactoryAssistant(options: FactoryAssistantOptions): FactoryAssistant {
  let catalog: ModelCatalog | undefined;

  const models: AssistantModels = {
    async list(owner) {
      if (!catalog) throw new AssistantError('models_unavailable', 'The model catalog is not ready yet.', 503);
      const tenantCredentials = await listSessionScopedCredentials({
        credentials: options.modelCredentials,
        orgId: owner.orgId,
        userId: owner.userId,
      });
      const entries = await buildModelCatalog({
        controller: catalog,
        tenantCredentials,
        deploymentProviders: options.deploymentProviders,
        ...(options.customProviders
          ? { listCustomProviders: () => options.customProviders!.list({ orgId: owner.orgId }) }
          : {}),
      });
      return entries.map(entry => ({ id: entry.id, provider: entry.provider, modelName: entry.modelName }));
    },
  };

  // The organization's credentials, as every Factory run bills them (ADR-0032): never personal ones,
  // never the server's environment. No model at all is a loud refusal the thread shows.
  const resolver: AssistantModelResolver = {
    async resolve(owner, modelId) {
      const tenant = { orgId: owner.orgId, userId: owner.userId, credentialScope: 'factory' as const };
      const id = modelId ?? (await resolveTenantProviderDefaultModel(tenant, undefined));
      if (!id) {
        throw new AssistantError(
          'no_org_model',
          'Your organization has no model connected, so the assistant cannot answer. An admin connects one in Settings › Моделі.',
          409,
        );
      }
      const requestContext = new RequestContext();
      requestContext.set('user', { id: owner.userId, organizationId: owner.orgId });
      await primeTenantCredentialsForRequestContext(requestContext);
      return {
        model: ({ requestContext: context }: { requestContext: RequestContext }) =>
          resolveModel(id, { remapForCodexOAuth: true, requestContext: context }),
        requestContext,
      };
    },
  };

  const authServer = authorizationServerOf(options.authProvider);
  const access = new FactoryAccess({
    storage: options.storage,
    cipher: options.secretEncryption,
    publicOrigin: options.publicOrigin,
    authServer:
      authServer ??
      (async () => {
        throw new AssistantError(
          'factory_access_unavailable',
          "This server's sign-in is not an authorization server, so the assistant cannot be allowed to reach Factory.",
          503,
        );
      }),
  });
  const factory = new McpFactoryClient({
    publicOrigin: options.publicOrigin,
    accessToken: owner => access.accessToken(owner),
    connected: async owner => (await access.status(owner)).connected,
  });

  const service = new AssistantService({
    storage: options.storage,
    ...(options.blobs ? { blobs: options.blobs } : {}),
    brain: createMastraAssistantBrain({ memory: createAssistantMemory(options.mastraStorage), models: resolver }),
    memory: createAssistantMemoryEraser(options.mastraStorage),
    models,
    factory,
    grant: access,
    blobReferencedElsewhere: options.blobReferencedElsewhere,
    audit: async event => {
      await options.audit.record({
        orgId: event.orgId,
        actorId: event.actorId,
        actorType: event.actorId === 'system' ? 'system' : 'human',
        action: 'factory.assistant.cleared',
        targets: [{ type: 'member', id: event.userId }],
        metadata: { reason: event.reason, requests: event.counts.requests, files: event.counts.files },
      });
    },
  });

  if (hasRemovalHooks(options.authProvider)) {
    options.authProvider.onMemberRemoved(async (orgId, userId) => {
      await service.clear({ orgId, userId }, { reason: 'member_removed', actorId: 'system' });
    });
    options.authProvider.onUserDeleted(async userId => {
      await service.clearUser(userId, { reason: 'account_deleted', actorId: 'system' });
    });
  } else if (options.authProvider) {
    console.error(
      '[assistant] The auth provider reports no member removals: assistants of people removed from an organization are not erased automatically.',
    );
  }

  const retention: RetentionJob = startAssistantRetention(service);

  return {
    service,
    routes({ auth, controller }) {
      catalog = controller;
      return buildAssistantRoutes({ auth, service, access, models });
    },
    stop() {
      retention.stop();
    },
  };
}
