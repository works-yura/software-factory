import type { ConversationChannel, ConversationRouter, InboundMessage } from '@factory/integrations';
import type { IssueReconcileSummary } from '@factory/integrations';
import type { FactoryProject, FactoryProjectsStorage, IntakeStorage, WorkItemRow, WorkItemsStorage } from '@factory/store';

import type { ClickUpTask, ClickUpThreadComment, ClickUpUser } from './api.ts';
import type { IntakeRoutesReader } from '@factory/core';

import { CLICKUP_INTEGRATION_ID, routedClickUpLists } from './lists.ts';

export const CLICKUP_PLATFORM = 'clickup';
const DAY_MS = 24 * 60 * 60_000;

/** What the conversation side reads from and writes to ClickUp; `ClickUpClient` implements it. */
export interface ClickUpConversationClient {
  listTasks(input: { listId: string; updatedAfter?: Date; includeClosed?: boolean }): Promise<ClickUpTask[]>;
  listThreadComments(taskId: string): Promise<ClickUpThreadComment[]>;
  listReplies(commentId: string): Promise<ClickUpThreadComment[]>;
  replyToComment(commentId: string, body: string): Promise<void>;
  authorizedUser(): Promise<ClickUpUser>;
  download(url: string): Promise<Uint8Array>;
}

/** A thread is a top-level task comment; replies go under it. Ref: `<taskId>:<commentId>`. */
export function clickUpThreadId(taskId: string, commentId: string): string {
  return `${taskId}:${commentId}`;
}

function parseThreadId(id: string): { taskId: string; commentId: string } {
  const [taskId, commentId, ...rest] = id.split(':');
  if (!taskId || !commentId || rest.length > 0) throw new Error(`Not a ClickUp thread reference: "${id}".`);
  return { taskId, commentId };
}

/** ClickUp's outbound half of a conversation channel. */
export function createClickUpChannel(client: Pick<ClickUpConversationClient, 'replyToComment' | 'download'>): ConversationChannel {
  return {
    platform: CLICKUP_PLATFORM,
    reply: async (thread, text) => {
      if (thread.platform !== CLICKUP_PLATFORM) throw new Error(`Thread ${thread.id} is not a ClickUp thread.`);
      await client.replyToComment(parseThreadId(thread.id).commentId, text);
    },
    download: attachment => client.download(attachment.url),
  };
}

export interface ClickUpConversationPollerOptions {
  client: ClickUpConversationClient;
  router: Pick<ConversationRouter, 'handle'>;
  intake: Pick<IntakeStorage, 'getConfig'>;
  /** The Factories' intake routes: the Lists they name are the ones whose comment threads are read. */
  intakeRoutes: IntakeRoutesReader;
  projects: Pick<FactoryProjectsStorage, 'listAll'>;
  workItems: Pick<WorkItemsStorage, 'getByProjectSource'>;
  now?: () => Date;
}

export interface ClickUpConversationSweep extends IssueReconcileSummary {
  /** Cards for the router's lookups, keyed by thread id; refreshed every sweep. */
  cards: Map<string, { project: FactoryProject; card: WorkItemRow }>;
}

/**
 * Reads comments on the tasks of the ClickUp Lists Settings › Intake watches and hands every
 * new one on a task Factory has a card for to the conversation router. Polling, like the rest of
 * the ClickUp integration: no webhook, so a local server without a public URL works. Comments
 * written before the server started are never replayed; replies are read only in threads Factory
 * was addressed in.
 */
export function createClickUpConversationPoller(options: ClickUpConversationPollerOptions) {
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const cursors = new Map<string, Date>();
  /** Top-level comment ids of threads Factory was addressed in. */
  const joined = new Set<string>();
  const cards = new Map<string, { project: FactoryProject; card: WorkItemRow }>();
  let bot: ClickUpUser | undefined;

  const inbound = (
    task: ClickUpTask,
    threadCommentId: string,
    comment: ClickUpThreadComment,
    me: ClickUpUser,
    inJoinedThread: boolean,
  ): InboundMessage => ({
    platform: CLICKUP_PLATFORM,
    id: comment.id,
    thread: { platform: CLICKUP_PLATFORM, id: clickUpThreadId(task.id, threadCommentId) },
    sender: {
      teamId: task.teamId ?? '',
      userId: comment.authorId,
      name: comment.authorName,
      mention: `@${comment.authorName}`,
    },
    fromBot: comment.authorId === me.id,
    addressedToBot: comment.mentions.includes(me.id) || inJoinedThread,
    text: comment.text,
    attachments: comment.attachments,
    subject: { integrationId: CLICKUP_INTEGRATION_ID, type: 'task', externalId: task.id, url: task.url, title: task.name },
    createdAt: comment.createdAt,
  });

  const sweep = async (): Promise<ClickUpConversationSweep> => {
    const summary: ClickUpConversationSweep = {
      projects: 0,
      checked: 0,
      updated: 0,
      closed: 0,
      missing: 0,
      failed: 0,
      errors: [],
      cards,
    };
    bot ??= await options.client.authorizedUser();
    const me = bot;
    const touched = new Set<string>();

    for (const { project, listId } of await routedClickUpLists(options)) {
      const orgId = project.orgId;
      {
        touched.add(project.id);
        const cursorKey = `${project.id}:${listId}`;
        const since = cursors.get(cursorKey) ?? new Date(startedAt.getTime() - DAY_MS);
        let newest = since;
        let failed = false;
        try {
          for (const task of await options.client.listTasks({ listId, updatedAfter: since, includeClosed: false })) {
            const card = await options.workItems.getByProjectSource({
              orgId,
              factoryProjectId: project.id,
              source: { integrationId: CLICKUP_INTEGRATION_ID, type: 'task', externalId: task.id, url: task.url },
            });
            if (!card) continue;
            try {
              for (const comment of await options.client.listThreadComments(task.id)) {
                const thread = clickUpThreadId(task.id, comment.id);
                cards.set(thread, { project, card });
                const messages: InboundMessage[] = [];
                if (Date.parse(comment.createdAt) > startedAt.getTime()) messages.push(inbound(task, comment.id, comment, me, false));
                if (joined.has(comment.id) && comment.replyCount > 0) {
                  for (const reply of await options.client.listReplies(comment.id)) {
                    if (Date.parse(reply.createdAt) > startedAt.getTime()) messages.push(inbound(task, comment.id, reply, me, true));
                  }
                }
                for (const message of messages) {
                  summary.checked += 1;
                  const outcome = await options.router.handle(message);
                  if (outcome === 'delivered' || outcome === 'connect-card' || outcome === 'linked') {
                    joined.add(comment.id);
                    summary.updated += 1;
                  }
                }
              }
              const updated = new Date(task.updatedAt);
              if (updated > newest) newest = updated;
            } catch (error) {
              failed = true;
              summary.failed += 1;
              summary.errors.push({ projectId: project.id, workItemId: card.id, error: error instanceof Error ? error.message : String(error) });
            }
          }
        } catch (error) {
          failed = true;
          summary.failed += 1;
          summary.errors.push({ projectId: project.id, error: error instanceof Error ? error.message : String(error) });
        }
        if (!failed) cursors.set(cursorKey, newest);
      }
    }
    summary.projects = touched.size;
    return summary;
  };

  return {
    sweep,
    /** The router's `findCard`: the card the sweep saw for the message's thread, re-read for its revision. */
    findCard: async (message: InboundMessage) => {
      const entry = cards.get(message.thread.id);
      if (!entry) return null;
      const card = await options.workItems.getByProjectSource({
        orgId: entry.project.orgId,
        factoryProjectId: entry.project.id,
        source: { integrationId: CLICKUP_INTEGRATION_ID, type: 'task', externalId: message.subject.externalId },
      });
      return card ? { orgId: entry.project.orgId, factoryProjectId: entry.project.id, card } : null;
    },
  };
}
