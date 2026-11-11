import type { ApiRoute } from '@mastra/core/server';
import type { MastraWorker } from '@mastra/core/worker';

import { IssueReconcileWorker } from '@factory/integrations';
import type { FactoryIntegration, IntegrationContext } from '@factory/integrations';

import { ClickUpClient } from './api.ts';
import type { ClickUpTaskSource } from './api.ts';
import { ClickUpIntake } from './intake.ts';
import { createClickUpPoller } from './poller.ts';
import { buildClickUpRoutes } from './routes.ts';
import { readClickUpSettings } from './settings.ts';
import { toBoardSource } from '@factory/core';

export const DEFAULT_CLICKUP_POLL_SECONDS = 60;

export interface ClickUpIntegrationOptions {
  /** Personal API token (`pk_...`); a service account's token outlives staff changes. */
  apiToken: string;
  intervalSeconds?: number;
  /** Test seam: replaces the HTTP client the poller reads tasks with. */
  taskSource?: ClickUpTaskSource;
}

/**
 * ClickUp by polling: no webhook, so it works on a local server with no public URL. Which Lists
 * are watched, where they route and which tags pick a board all live in Settings › Intake; the
 * token comes from the host's environment. Read-only toward ClickUp apart from what agents do
 * through the Intake capability (comments, status).
 */
export class ClickUpIntegration implements FactoryIntegration {
  readonly id = 'clickup';
  readonly intake: ClickUpIntake;

  readonly #client: ClickUpClient;
  readonly #taskSource: ClickUpTaskSource;
  readonly #intervalSeconds: number;

  constructor(options: ClickUpIntegrationOptions) {
    this.#client = new ClickUpClient({ token: options.apiToken });
    this.intake = new ClickUpIntake(this.#client, options.apiToken.trim());
    this.#taskSource = options.taskSource ?? this.#client;
    this.#intervalSeconds = Math.max(15, options.intervalSeconds ?? DEFAULT_CLICKUP_POLL_SECONDS);
  }

  routes(ctx: IntegrationContext): ApiRoute[] {
    return buildClickUpRoutes({
      auth: ctx.auth,
      client: this.#client,
      intake: this.intake,
      storage: ctx.storage.generic,
      intervalSeconds: this.#intervalSeconds,
    });
  }

  workers(ctx: IntegrationContext): MastraWorker[] {
    if (!ctx.runtime) return [];
    const storage = ctx.storage.generic;
    const reconcile = createClickUpPoller({
      client: this.#taskSource,
      intake: ctx.storage.intake,
      rules: async orgId => (await readClickUpSettings(storage, orgId)).lists,
      projects: ctx.storage.projects,
      workItems: ctx.runtime.workItems,
      // Card lookups read the code boards; stored boards come through `projectBoards` for routing.
      boards: toBoardSource(ctx.runtime.boards).codeRegistry,
      ...(ctx.runtime.intakeRoutes ? { intakeRoutes: ctx.runtime.intakeRoutes } : {}),
      ...(ctx.runtime.projectBoards ? { projectBoards: ctx.runtime.projectBoards } : {}),
      configVersion: ctx.runtime.configVersion,
    });
    return [new IssueReconcileWorker({ integrationId: this.id, reconcile, intervalMs: this.#intervalSeconds * 1000 })];
  }

  diagnostics(): Record<string, unknown> {
    return { mode: 'polling', tokenConfigured: true, intervalSeconds: this.#intervalSeconds };
  }
}
