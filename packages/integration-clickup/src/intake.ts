import type {
  CreateIntakeCommentInput,
  CreatedIntakeComment,
  GetIntakeIssueInput,
  Intake,
  IntakeIssue,
  IntakeIssueDetail,
  IntakeItemPage,
  IntakeSource,
  ListIntakeIssuesInput,
  ListIntakeItemsInput,
  ResolveIntakeDispatchInput,
  ResolvedIntakeDispatch,
  UpdateIntakeIssueInput,
} from '@factory/capabilities';

import { ClickUpApiError } from './api.ts';
import type { ClickUpClient, ClickUpList, ClickUpTask } from './api.ts';

const SOURCE_CACHE_MS = 60_000;

/** ClickUp status types (`open`, `custom`, `done`, `closed`) in the vocabulary Intake shares across providers. */
export function stateTypeOf(task: Pick<ClickUpTask, 'status'>): 'unstarted' | 'started' | 'completed' {
  switch (task.status.type) {
    case 'open':
      return 'unstarted';
    case 'done':
    case 'closed':
      return 'completed';
    default:
      return 'started';
  }
}

export function isClosedTask(task: Pick<ClickUpTask, 'status'>): boolean {
  return task.status.type === 'closed' || task.status.type === 'done';
}

function encodeCursor(cursor: { source: number; page: number }): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function decodeCursor(value: string | undefined): { source: number; page: number } | null {
  if (!value) return { source: 0, page: 0 };
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>;
    const { source, page } = parsed;
    return Number.isInteger(source) && Number.isInteger(page) && (source as number) >= 0 && (page as number) >= 0
      ? { source: source as number, page: page as number }
      : null;
  } catch {
    return null;
  }
}

/** ClickUp as an intake provider: Lists are sources, tasks are issues. */
export class ClickUpIntake implements Intake {
  readonly #client: ClickUpClient;
  readonly #token: string;
  #sources: { at: number; value: ClickUpList[] } | undefined;

  constructor(client: ClickUpClient, token: string) {
    this.#client = client;
    this.#token = token;
  }

  /** Lists of every Workspace the token can see; cached briefly because it fans out over Spaces. */
  async lists(): Promise<ClickUpList[]> {
    if (this.#sources && Date.now() - this.#sources.at < SOURCE_CACHE_MS) return this.#sources.value;
    const lists: ClickUpList[] = [];
    for (const workspace of await this.#client.listWorkspaces()) lists.push(...(await this.#client.listLists(workspace)));
    this.#sources = { at: Date.now(), value: lists };
    return lists;
  }

  resolveIntakeDispatch = async ({ externalSource }: ResolveIntakeDispatchInput): Promise<ResolvedIntakeDispatch | null> => {
    if (externalSource.type !== 'task') return null;
    const task = await this.#client.getTask(externalSource.externalId);
    if (!task) return null;
    return {
      connection: { type: 'oauth', accessToken: this.#token },
      ...(task.listId ? { sourceId: task.listId } : {}),
      issueId: task.id,
    };
  };

  listSources = async (): Promise<IntakeSource[]> =>
    (await this.lists()).map(list => ({
      id: list.id,
      name: list.path ? `${list.path} / ${list.name}` : list.name,
      type: 'list',
      metadata: { workspaceId: list.workspaceId },
    }));

  listItems = async (input: ListIntakeItemsInput): Promise<IntakeItemPage> => {
    const page = await this.#page(input.sourceIds, input.cursor);
    return {
      items: page.tasks.map(({ task, listId }) => ({
        source: { type: 'task', externalId: task.id, url: task.url },
        sourceId: listId,
        title: task.name,
        status: task.status.name,
        labels: task.tags,
        assignee: task.assignees[0] ?? null,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        metadata: { identifier: task.id, description: task.description.slice(0, 2_000) },
      })),
      nextCursor: page.nextCursor,
    };
  };

  listIssues = async (input: ListIntakeIssuesInput) => {
    const page = await this.#page(input.sourceIds, input.cursor);
    const wanted = (input.labels ?? []).map(label => label.toLowerCase());
    return {
      issues: page.tasks
        .filter(({ task }) => wanted.length === 0 || task.tags.some(tag => wanted.includes(tag.toLowerCase())))
        .map(({ task, listId }) => ({ ...toIssue(task), sourceId: listId })),
      nextCursor: page.nextCursor,
    };
  };

  getIssue = async (input: GetIntakeIssueInput): Promise<IntakeIssueDetail | null> => {
    const task = await this.#client.getTask(input.issueId);
    if (!task) return null;
    const comments = await this.#client.listComments(task.id);
    return { ...toIssue(task), description: task.description || null, comments };
  };

  createComment = async (input: CreateIntakeCommentInput): Promise<CreatedIntakeComment | null> => {
    const created = await this.#client.createComment(input.issueId, input.body);
    return { id: created.id, url: '' };
  };

  updateIssue = async (input: UpdateIntakeIssueInput): Promise<IntakeIssue | null> => {
    const task = await this.#client.getTask(input.issueId);
    if (!task) return null;
    const status = await this.#targetStatus(task, input.state);
    if (!status) return null;
    if (status !== task.status.name) await this.#client.setTaskStatus(task.id, status);
    const refreshed = (await this.#client.getTask(task.id)) ?? task;
    return toIssue(refreshed);
  };

  async #targetStatus(task: ClickUpTask, state: UpdateIntakeIssueInput['state']): Promise<string | null> {
    if (state.kind === 'byName') return state.name;
    if (state.stateType === 'canceled' || !task.listId) return null;
    const wantedTypes = { unstarted: ['open'], started: ['custom'], completed: ['closed', 'done'] }[state.stateType];
    const { statuses } = await this.#client.getList(task.listId);
    for (const type of wantedTypes) {
      const match = statuses.find(status => status.type === type);
      if (match) return match.name;
    }
    return null;
  }

  /** Tasks of the next List page, walking the selected Lists in order. */
  async #page(sourceIds: string[], cursorValue: string | undefined) {
    const cursor = decodeCursor(cursorValue);
    if (!cursor || cursor.source >= sourceIds.length) return { tasks: [], nextCursor: null };
    const listId = sourceIds[cursor.source]!;
    let result;
    try {
      result = await this.#client.listTasksPage({ listId, page: cursor.page });
    } catch (error) {
      // A List removed or hidden since it was selected must not break the whole intake feed.
      if (error instanceof ClickUpApiError && (error.status === 404 || error.status === 403)) {
        result = { tasks: [], lastPage: true };
      } else {
        throw error;
      }
    }
    const nextCursor = !result.lastPage
      ? encodeCursor({ source: cursor.source, page: cursor.page + 1 })
      : cursor.source + 1 < sourceIds.length
        ? encodeCursor({ source: cursor.source + 1, page: 0 })
        : null;
    return { tasks: result.tasks.map(task => ({ task, listId })), nextCursor };
  }
}

function toIssue(task: ClickUpTask): IntakeIssue {
  return {
    id: task.id,
    identifier: task.id,
    title: task.name,
    url: task.url,
    author: task.creator,
    authorUsername: task.creator,
    state: task.status.name || null,
    stateType: stateTypeOf(task),
    priority: task.priority,
    assignee: task.assignees[0] ?? null,
    assignees: task.assignees,
    source: null,
    sourceId: task.listId,
    projectId: null,
    labels: task.tags,
    commentCount: null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}
