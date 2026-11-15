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
  startAssistantDigests,
  startAssistantRetention,
} from '@factory/assistant-core';
import type {
  AssistantModelResolver,
  AssistantModels,
  AssistantSkills,
  AssistantStorage,
  DigestJob,
  RetentionJob,
} from '@factory/assistant-core';
import { buildClickUpSourceRoutes, ClickUpChatSource, startClickUpPolling } from '@factory/assistant-source-clickup';
import type { ClickUpPolling, ClickUpSourceStorage, OrgClickUpReader } from '@factory/assistant-source-clickup';
import { clickUpMetadataOf, clickUpTokenOf } from '@factory/integration-clickup';
import {
  buildModelCatalog,
  listSessionScopedCredentials,
  primeTenantCredentialsForRequestContext,
  resolveTenantProviderDefaultModel,
} from '@factory/credentials';
import type { ModelCatalog } from '@factory/credentials';
import type { RouteAuth } from '@factory/http';
import { listFactorySkills } from '@factory/harness-mastra';
import type {
  AttachmentBlobStore,
  ChannelIdentityStorage,
  IntegrationStorageHandle,
  AuditStorage,
  CustomProvidersStorage,
  FactorySecretEncryption,
  ModelCredentialsStorage,
} from '@factory/store';
import { resolveModel } from '@mastra/code-sdk/agents/model';
import { RequestContext } from '@mastra/core/request-context';
import type { ApiRoute } from '@mastra/core/server';
import type { InlineSkill } from '@mastra/core/skills';
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
  /** The person's own ClickUp Chat connections (phase 2); without it ClickUp is not offered. */
  clickupStorage?: ClickUpSourceStorage;
  /** Polling of ClickUp; tests and servers without a background loop turn it off. */
  pollClickUp?: boolean;
  /** The digest timer (phase 3); tests turn it off and tick by hand. */
  runDigests?: boolean;
  /**
   * The app's own skills (`MastraFactory({ skills })`): with the bundled skills and the app's
   * `factory-skills/` folder they make the catalogue a person picks the assistant's skills from.
   */
  codeSkills?: readonly InlineSkill[];
  /** The organization's ClickUp connection, offered to the one person whose own account its token is. */
  orgClickUp?: OrgClickUpReader;
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

/**
 * The organization's ClickUp connection (`clickup:org`, Settings › Підключення) and the ADR-0018
 * identity links, as the assistant's ClickUp source proves whose account the token is.
 */
export function createOrgClickUpReader(input: {
  connections: Pick<IntegrationStorageHandle, 'connections'>;
  links: Pick<ChannelIdentityStorage, 'listAccountLinksForOrg'>;
}): OrgClickUpReader {
  return {
    async connection(orgId) {
      const row = await input.connections.connections.get(orgId);
      const token = clickUpTokenOf(row?.data);
      const account = clickUpMetadataOf(row?.metadata);
      if (!row || !token || !account) return null;
      return { token, savedBy: row.userId, account: { id: account.userId, name: account.username, workspaces: account.workspaces } };
    },
    async linkedUsers(orgId, clickUpUserId) {
      const links = await input.links.listAccountLinksForOrg(orgId, { limit: 1000 });
      return links
        .filter(link => link.platform === 'clickup' && link.externalUserId === clickUpUserId && link.orgId === orgId)
        .map(link => link.userId);
    },
  };
}

export interface FactoryAssistant {
  service: AssistantService;
  /** The ClickUp Chat source, when the server has its storage. */
  clickup: ClickUpChatSource | undefined;
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

  /**
   * The model a person who has not chosen one runs on: the same pick a new Factory chat makes when
   * its Factory has no default (Settings › Моделі «built-in default», `/web/config/models`) — the
   * harness's default-mode model when the organization can run it, otherwise the default model of
   * the first connected provider in `PROVIDER_DEFAULT_MODELS` order. There is no organization-wide
   * default setting (defaults are per Factory), so this is the organization-level equivalent. A
   * failing model is never swapped for another provider: the thread names it and the person picks.
   */
  async function organizationDefaultModel(owner: { orgId: string; userId: string }): Promise<string | undefined> {
    const tenant = { orgId: owner.orgId, userId: owner.userId, credentialScope: 'factory' as const };
    const modeModelId = catalog?.getDefaultMode?.().defaultModelId;
    const providerDefault = await resolveTenantProviderDefaultModel(tenant, modeModelId);
    if (providerDefault) return providerDefault;
    if (!modeModelId) return undefined;
    // `undefined` above means either "the mode's model is usable" or "nothing is connected".
    const listed = await models.list(owner);
    return listed.some(model => model.id === modeModelId) ? modeModelId : undefined;
  }

  // The organization's credentials, as every Factory run bills them (ADR-0032): never personal ones,
  // never the server's environment. No model at all is a loud refusal the thread shows.
  const resolver: AssistantModelResolver = {
    async resolve(owner, modelId) {
      const id = modelId ?? (await organizationDefaultModel(owner));
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
        modelId: id,
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

  // The Factory skills catalogue (phase 3): the same SKILL.md files Factory sessions load — bundled,
  // the app's `factory-skills/` folder, `MastraFactory({ skills })` — read through the same loader.
  // Skills are deployment-wide, with edits per Factory project; the assistant belongs to no project,
  // so it gets the originals (no project's edits). Skills that do not load are not offered.
  const skills: AssistantSkills = {
    async list() {
      return (await listFactorySkills(options.codeSkills ?? []))
        .filter(skill => !skill.error)
        .map(skill => ({ name: skill.name, description: skill.description }));
    },
    async read(_owner, name) {
      const skill = (await listFactorySkills(options.codeSkills ?? [])).find(candidate => candidate.name === name && !candidate.error);
      return skill ? { name: skill.name, description: skill.description, instructions: skill.content } : null;
    },
  };

  // ClickUp Chat, read with the person's own personal token (ADR-0051 phase 2). The core takes its
  // messages in; the source is erased first when the assistant is.
  let ingest: AssistantService | undefined;
  const clickup = options.clickupStorage
    ? new ClickUpChatSource({
        storage: options.clickupStorage,
        cipher: options.secretEncryption,
        ...(options.orgClickUp ? { orgClickUp: options.orgClickUp } : {}),
        ingest: {
          ingestSourceMessage: (owner, message) => ingest!.ingestSourceMessage(owner, message),
          hasOpenSourceRequest: (owner, key) => ingest!.hasOpenSourceRequest(owner, key),
        },
        checkRule: (owner, rule) => ingest!.checkChannelRule(owner, rule),
      })
    : undefined;

  const service = new AssistantService({
    storage: options.storage,
    ...(clickup ? { sources: [clickup] } : {}),
    skills,
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

  ingest = service;

  const retention: RetentionJob = startAssistantRetention(service);
  const polling: ClickUpPolling | undefined = clickup && options.pollClickUp !== false ? startClickUpPolling(clickup) : undefined;
  const digests: DigestJob | undefined = options.runDigests !== false ? startAssistantDigests(service) : undefined;

  return {
    service,
    clickup,
    routes({ auth, controller }) {
      catalog = controller;
      return [
        ...buildAssistantRoutes({ auth, service, access, models }),
        ...(clickup ? buildClickUpSourceRoutes({ auth, source: clickup }) : []),
      ];
    },
    stop() {
      retention.stop();
      polling?.stop();
      digests?.stop();
    },
  };
}
