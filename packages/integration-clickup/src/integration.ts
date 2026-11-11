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
  IntegrationTools,
  Transcriber,
} from '@factory/integrations';

import { ClickUpClient } from './api.ts';
import type { ClickUpTaskSource } from './api.ts';
import { ClickUpIntake } from './intake.ts';
import { createClickUpPoller } from './poller.ts';
import { buildClickUpRoutes } from './routes.ts';
import { CLICKUP_PLATFORM, createClickUpChannel, createClickUpConversationPoller } from './conversation.ts';
import type { ClickUpConversationClient } from './conversation.ts';
import { readClickUpSettings } from './settings.ts';
import { toBoardSource } from '@factory/core';

export const DEFAULT_CLICKUP_POLL_SECONDS = 60;

export interface ClickUpIntegrationOptions {
  /** Personal API token (`pk_...`); a service account's token outlives staff changes. */
  apiToken: string;
  intervalSeconds?: number;
  /** Test seam: replaces the HTTP client the poller reads tasks with. */
  taskSource?: ClickUpTaskSource;
  /** Test seam: replaces the HTTP client task comments are read from and replied with. */
  conversationClient?: ClickUpConversationClient;
  /** Speech-to-text for voice clips in comments; without it a clip reaches the agent with a note. */
  transcriber?: Transcriber;
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
  readonly #conversationClient: ClickUpConversationClient;
  readonly #channel: ConversationChannel;
  readonly #codes = new ConnectCodes();
  readonly #transcriber: Transcriber | undefined;

  constructor(options: ClickUpIntegrationOptions) {
    this.#client = new ClickUpClient({ token: options.apiToken });
    this.#conversationClient = options.conversationClient ?? this.#client;
    this.#channel = createClickUpChannel(this.#conversationClient);
    this.#transcriber = options.transcriber;
    this.intake = new ClickUpIntake(this.#client, options.apiToken.trim());
    this.#taskSource = options.taskSource ?? this.#client;
    this.#intervalSeconds = Math.max(15, options.intervalSeconds ?? DEFAULT_CLICKUP_POLL_SECONDS);
  }

  routes(ctx: IntegrationContext): ApiRoute[] {
    return [
      ...buildClickUpRoutes({
        auth: ctx.auth,
        client: this.#client,
        intake: this.intake,
        storage: ctx.storage.generic,
        intervalSeconds: this.#intervalSeconds,
      }),
      buildConnectCodeRoute({ platform: CLICKUP_PLATFORM, auth: ctx.auth, codes: this.#codes }),
    ];
  }

  /** `factory_conversation_reply`: the agent answers in the ClickUp comment thread it was asked in. */
  sessionTools(_args: { requestContext: RequestContext }): IntegrationTools {
    return createConversationReplyTool([this.#channel]);
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
      client: this.#conversationClient,
      router,
      intake: ctx.storage.intake,
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
      tokenConfigured: true,
      intervalSeconds: this.#intervalSeconds,
      conversations: { transcription: this.#transcriber ? 'configured' : 'not configured' },
    };
  }
}
