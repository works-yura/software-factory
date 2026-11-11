import type { ApiRoute } from '@mastra/core/server';
import type { RequestContext } from '@mastra/core/request-context';

import { createObservabilityTools } from '@factory/integrations';
import type { FactoryIntegration, IntegrationContext, IntegrationTools } from '@factory/integrations';
import type { IntegrationStorageHandle } from '@factory/store';

import { buildFirebaseRoutes } from './routes.ts';
import type { FetchLike } from './service-account.ts';
import { FIREBASE_INTEGRATION_ID } from './settings.ts';
import { FirebaseObservabilityProvider } from './source.ts';

export interface FirebaseIntegrationOptions {
  /** Test seam: every call to Google goes through it. */
  fetch?: FetchLike;
}

/**
 * Firebase for observability: read-only server logs (Cloud Logging) and app crashes (Crashlytics)
 * for agents. Nothing lives in the host's env: each organization uploads its own service account
 * key in Settings › Logs and crashes (stored encrypted), and maps each Factory to a project and apps.
 */
export class FirebaseIntegration implements FactoryIntegration {
  readonly id = FIREBASE_INTEGRATION_ID;
  readonly #options: FirebaseIntegrationOptions;
  #provider: FirebaseObservabilityProvider | undefined;

  constructor(options: FirebaseIntegrationOptions = {}) {
    this.#options = options;
  }

  initialize({ storage }: { storage: IntegrationStorageHandle }): void {
    this.#provider = new FirebaseObservabilityProvider(storage, this.#options.fetch ? { fetch: this.#options.fetch } : {});
  }

  /** The observability provider; available once the factory initialized the integration. */
  get observability(): FirebaseObservabilityProvider {
    if (!this.#provider) throw new Error('FirebaseIntegration used before initialize().');
    return this.#provider;
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
    return { mode: 'per-organization service account', initialized: this.#provider !== undefined };
  }
}
