import type { ApiRoute } from '@mastra/core/server';
import type { MastraWorker } from '@mastra/core/worker';

import type { RequestContext } from '@mastra/core/request-context';

import {
  buildConnectCodeRoute,
  ConnectCodes,
  ConversationRouter,
  createConversationReplyTool,
  IssueReconcileWorker,
} from '@factory/integrations';
import type {
  ConversationChannel,
  ConversationRouterOptions,
  FactoryIntegration,
  IntegrationContext,
  IntegrationMigrationContext,
  IntegrationTools,
  Transcriber,
} from '@factory/integrations';
import type { IntegrationStorageHandle } from '@factory/store';

import { ClickUpIntake } from './intake.ts';
import { createClickUpPoller } from './poller.ts';
import { buildClickUpRoutes } from './routes.ts';
import { CLICKUP_PLATFORM, createClickUpChannel, createClickUpConversationPoller } from './conversation.ts';
import { adoptDeploymentClickUpToken, ClickUpClients } from './connection.ts';
import type { ClickUpClientFactory, ClickUpConnectionStorage } from './connection.ts';
import { migrateListStatusRules } from './status-routes.ts';

export const DEFAULT_CLICKUP_POLL_SECONDS = 60;

export interface ClickUpIntegrationOptions {
  intervalSeconds?: number;
  /** Test seam: builds the client an organization's token talks to ClickUp through. */
  createClient?: ClickUpClientFactory;
  /** Speech-to-text for voice clips in comments; without it a clip reaches the agent with a note. */
  transcriber?: Transcriber;
}

/**
 * ClickUp by polling: no webhook, so it works on a local server with no public URL. Each
 * organization connects its own ClickUp token in Settings › Підключення (stored encrypted in its
 * `integration_connections` row, ADR-0032); every read and write uses the token of the organization
 * it is for, and an organization without one reads nothing. The Lists read are the ones the
 * project's intake routes name, and those routes place every task. Read-only toward ClickUp apart
 * from what agents do through the Intake capability (comments, status).
 */
export class ClickUpIntegration implements FactoryIntegration {
  readonly id = 'clickup';
  readonly intake: ClickUpIntake;
  /** ClickUp imports and moves cards only through intake routes (stored with the boards). */
  readonly requiredDomains = ['intake', 'boards', 'work-items'] as const;

  readonly #clients: ClickUpClients;
  readonly #intervalSeconds: number;
  readonly #channel: ConversationChannel;
  readonly #codes = new ConnectCodes();
  readonly #transcriber: Transcriber | undefined;
  readonly #createClient: ClickUpClientFactory | undefined;
  #storage: IntegrationStorageHandle | undefined;

  constructor(options: ClickUpIntegrationOptions = {}) {
    this.#createClient = options.createClient;
    this.#clients = new ClickUpClients({
      storage: () => this.#connections(),
      ...(options.createClient ? { create: options.createClient } : {}),
    });
    this.#channel = createClickUpChannel(this.#clients);
    this.#transcriber = options.transcriber;
    this.intake = new ClickUpIntake(this.#clients);
    this.#intervalSeconds = Math.max(15, options.intervalSeconds ?? DEFAULT_CLICKUP_POLL_SECONDS);
  }

  initialize({ storage }: { storage: IntegrationStorageHandle }): void {
    this.#storage = storage;
  }

  #connections(): ClickUpConnectionStorage {
    if (!this.#storage) throw new Error('ClickUpIntegration used before initialize().');
    return this.#storage;
  }

  routes(ctx: IntegrationContext): ApiRoute[] {
    return [
      ...buildClickUpRoutes({
        auth: ctx.auth,
        clients: this.#clients,
        storage: () => this.#connections(),
        intake: this.intake,
        intervalSeconds: this.#intervalSeconds,
        ...(ctx.hooks ? { hooks: ctx.hooks } : {}),
      }),
      buildConnectCodeRoute({ platform: CLICKUP_PLATFORM, auth: ctx.auth, codes: this.#codes }),
    ];
  }

  /**
   * `factory_conversation_reply`: the agent answers in the ClickUp comment thread it was asked in,
   * with its session organization's token.
   */
  sessionTools({ requestContext }: { requestContext: RequestContext }): IntegrationTools {
    return createConversationReplyTool([this.#channel], requestContext);
  }

  /**
   * The one-time move of the retired deployment token (`CLICKUP_API_TOKEN`) into an organization's
   * connection; run by the factory's boot migration `integrations.envTokensToOrg.clickup.v1`.
   */
  async adoptDeploymentToken(input: {
    storage: IntegrationStorageHandle;
    orgId: string;
    env: Readonly<Record<string, string>>;
  }): Promise<string | undefined> {
    return adoptDeploymentClickUpToken({
      storage: input.storage,
      orgId: input.orgId,
      token: input.env.CLICKUP_API_TOKEN,
      ...(this.#createClient ? { create: this.#createClient } : {}),
    });
  }

  /** Moves the retired per-List status rules into intake routes, once per boot (idempotent). */
  async migrate(ctx: IntegrationMigrationContext): Promise<void> {
    const orgIds = [...new Set((await ctx.projects.listAll()).map(project => project.orgId))];
    const result = await migrateListStatusRules({
      orgIds,
      settings: ctx.storage,
      intake: ctx.intake,
      intakeRoutes: ctx.intakeRoutes,
      projectBoards: ctx.projectBoards,
    });
    if (result.lists + result.named > 0) {
      console.info(`[clickup] moved the status rules of ${result.lists} List(s) into intake routes; named ${result.named} route(s)`);
    }
  }

  workers(ctx: IntegrationContext): MastraWorker[] {
    if (!ctx.runtime) return [];
    const { intakeRoutes, projectBoards } = ctx.runtime;
    // Unreachable while `requiredDomains` holds: the factory counts ClickUp not ready without boards.
    if (!intakeRoutes || !projectBoards) {
      throw new Error('ClickUp intake needs the project intake routes (the boards domain); ClickUp should have been disabled.');
    }
    const reconcile = createClickUpPoller({
      clients: this.#clients,
      intake: ctx.storage.intake,
      projects: ctx.storage.projects,
      workItems: ctx.runtime.workItems,
      intakeRoutes,
      projectBoards,
      configVersion: ctx.runtime.configVersion,
    });
    if (!ctx.baseUrl) throw new Error("ClickUp conversations need the server's public URL for the connect link.");
    let findCard: ConversationRouterOptions['findCard'] = async () => null;
    const router = new ConversationRouter({
      channel: this.#channel,
      identities: ctx.storage.channelIdentity,
      codes: this.#codes,
      findCard: message => findCard(message),
      workItems: ctx.runtime.workItems,
      connectUrl: `${ctx.baseUrl.replace(/\/+$/, '')}/connect/${CLICKUP_PLATFORM}`,
      configVersion: ctx.runtime.configVersion,
      ...(this.#transcriber ? { transcriber: this.#transcriber } : {}),
    });
    const conversations = createClickUpConversationPoller({
      clients: this.#clients,
      router,
      intake: ctx.storage.intake,
      intakeRoutes,
      projects: ctx.storage.projects,
      workItems: ctx.runtime.workItems,
    });
    findCard = conversations.findCard;
    return [
      new IssueReconcileWorker({ integrationId: this.id, reconcile, intervalMs: this.#intervalSeconds * 1000 }),
      new IssueReconcileWorker({
        integrationId: `${this.id}-conversations`,
        reconcile: conversations.sweep,
        intervalMs: this.#intervalSeconds * 1000,
      }),
    ];
  }

  diagnostics(): Record<string, unknown> {
    return {
      mode: 'polling',
      tokens: 'per organization (Settings › Підключення)',
      intervalSeconds: this.#intervalSeconds,
      conversations: { transcription: this.#transcriber ? 'configured' : 'not configured' },
    };
  }
}
