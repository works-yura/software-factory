import type { ApiRoute } from '@mastra/core/server';
import type { RequestContext } from '@mastra/core/request-context';

import type { CredentialProvider } from '@factory/capabilities';
import type { ManagedMcpServerSpec } from '@factory/core';

import { createObservabilityTools } from '@factory/integrations';
import type { FactoryIntegration, IntegrationContext, IntegrationTools } from '@factory/integrations';
import type { IntegrationStorageHandle } from '@factory/store';

import { googleCloudAccountProvider } from './credentials.ts';
import { managedDatabaseServers } from './managed-mcp.ts';
import { buildFirebaseRoutes } from './routes.ts';
import type { FetchLike } from './service-account.ts';
import { FIREBASE_INTEGRATION_ID, readFirebaseState } from './settings.ts';
import { FirebaseObservabilityProvider } from './source.ts';

export interface FirebaseIntegrationOptions {
  /** Test seam: every call to Google goes through it. */
  fetch?: FetchLike;
}

/**
 * Firebase for observability: read-only server logs (Cloud Logging) and app crashes (Crashlytics)
 * for agents. Nothing lives in the host's env: each organization adds its Google Cloud service
 * accounts in Settings › Integrations › Google Cloud (keys stored encrypted), and binds each Factory to one or
 * more Google Cloud projects through one of them.
 */
export class FirebaseIntegration implements FactoryIntegration {
  readonly id = FIREBASE_INTEGRATION_ID;
  readonly #options: FirebaseIntegrationOptions;
  #provider: FirebaseObservabilityProvider | undefined;
  #storage: IntegrationStorageHandle | undefined;

  constructor(options: FirebaseIntegrationOptions = {}) {
    this.#options = options;
  }

  initialize({ storage }: { storage: IntegrationStorageHandle }): void {
    this.#storage = storage;
    this.#provider = new FirebaseObservabilityProvider(storage, this.#options.fetch ? { fetch: this.#options.fetch } : {});
  }

  /** The observability provider; available once the factory initialized the integration. */
  get observability(): FirebaseObservabilityProvider {
    if (!this.#provider) throw new Error('FirebaseIntegration used before initialize().');
    return this.#provider;
  }

  /** The Google Cloud accounts, for MCP servers that pick one instead of pasting its key. */
  credentialProviders(): CredentialProvider[] {
    if (!this.#storage) throw new Error('FirebaseIntegration used before initialize().');
    return [googleCloudAccountProvider(this.#storage, this.#options.fetch ? { fetch: this.#options.fetch } : {})];
  }

  /** «База» bindings run MCP Toolbox for their project's Firestore, managed here (Settings › Інтеграції › MCP). */
  async managedMcpServers(orgId: string): Promise<ManagedMcpServerSpec[]> {
    if (!this.#storage) throw new Error('FirebaseIntegration used before initialize().');
    return managedDatabaseServers((await readFirebaseState(this.#storage, orgId)).bindings);
  }

  routes(ctx: IntegrationContext): ApiRoute[] {
    return buildFirebaseRoutes({
      auth: ctx.auth,
      storage: ctx.storage.generic,
      projects: ctx.storage.projects,
      ...(ctx.hooks ? { hooks: ctx.hooks } : {}),
      ...(this.#options.fetch ? { fetch: this.#options.fetch } : {}),
    });
  }

  agentTools({ requestContext }: { requestContext: RequestContext }): Promise<IntegrationTools> {
    return createObservabilityTools({ requestContext, provider: this.observability });
  }

  diagnostics(): Record<string, unknown> {
    return { mode: 'service accounts per organization, bindings per Factory', initialized: this.#provider !== undefined };
  }
}
