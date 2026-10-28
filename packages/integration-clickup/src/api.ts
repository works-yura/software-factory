const CLICKUP_API_BASE = 'https://api.clickup.com/api/v2';
const MAX_PAGES = 50;
const SHARED_WITH_ME = 'Shared with me';

function isAccessDenied(error: unknown): boolean {
  return error instanceof ClickUpApiError && (error.status === 401 || error.status === 403);
}

export class ClickUpApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ClickUpApiError';
    this.status = status;
  }
}

export interface ClickUpTask {
  id: string;
  name: string;
  description: string;
  url: string;
  status: { name: string; type: string };
  tags: string[];
  creator: string | null;
  assignees: string[];
  priority: string | null;
  listId: string | null;
  /** ISO timestamps; ClickUp sends epoch milliseconds as strings. */
  createdAt: string;
  updatedAt: string;
}

export interface ClickUpComment {
  author: string | null;
  body: string;
  createdAt: string;
}

export interface ClickUpWorkspace {
  id: string;
  name: string;
}

/** A List with the path that makes same-named Lists distinguishable. */
export interface ClickUpList {
  id: string;
  name: string;
  /** `Space` or `Space / Folder`. */
  path: string;
  workspaceId: string;
}

export interface ClickUpListDetail {
  id: string;
  name: string;
  statuses: Array<{ name: string; type: string }>;
}

export interface ListTasksPageInput {
  listId: string;
  page: number;
  /** Only tasks updated after this instant. */
  updatedAfter?: Date;
  includeClosed?: boolean;
}

export interface ClickUpTaskPage {
  tasks: ClickUpTask[];
  lastPage: boolean;
}

/** What the poller needs; `ClickUpClient` is the real implementation. */
export interface ClickUpTaskSource {
  listTasks(input: Omit<ListTasksPageInput, 'page'>): Promise<ClickUpTask[]>;
}

export interface ClickUpClientOptions {
  token: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function isoFromEpoch(value: unknown): string {
  const millis = Number(value);
  return Number.isFinite(millis) && millis > 0 ? new Date(millis).toISOString() : new Date(0).toISOString();
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function names(value: unknown, key: string): string[] {
  return array(value).flatMap(entry => {
    const name = text(record(entry)[key]);
    return name ? [name] : [];
  });
}

export function parseClickUpTask(raw: unknown): ClickUpTask | null {
  const task = record(raw);
  const id = text(task.id);
  if (!id) return null;
  const status = record(task.status);
  const creator = text(record(task.creator).username);
  const priority = text(record(task.priority).priority);
  const listId = text(record(task.list).id);
  return {
    id,
    name: text(task.name),
    description: text(task.text_content) || text(task.description),
    url: text(task.url),
    status: { name: text(status.status), type: text(status.type) },
    tags: names(task.tags, 'name'),
    creator: creator || null,
    assignees: names(task.assignees, 'username'),
    priority: priority || null,
    listId: listId || null,
    createdAt: isoFromEpoch(task.date_created),
    updatedAt: isoFromEpoch(task.date_updated),
  };
}

/** ClickUp v2 client authenticated with a personal API token (`pk_...`). */
export class ClickUpClient implements ClickUpTaskSource {
  readonly #token: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: ClickUpClientOptions) {
    if (!options.token.trim()) throw new Error('ClickUp API token is required.');
    this.#token = options.token.trim();
    this.#baseUrl = (options.baseUrl ?? CLICKUP_API_BASE).replace(/\/+$/, '');
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /** One page of a List's tasks, newest update first. */
  async listTasksPage(input: ListTasksPageInput): Promise<ClickUpTaskPage> {
    const query = new URLSearchParams({
      page: String(input.page),
      order_by: 'updated',
      reverse: 'true',
      subtasks: 'true',
      include_closed: String(input.includeClosed ?? false),
    });
    if (input.updatedAfter) query.set('date_updated_gt', String(input.updatedAfter.getTime()));
    const body = await this.#request('GET', `/list/${encodeURIComponent(input.listId)}/task?${query}`);
    const tasks = array(body.tasks).flatMap(raw => {
      const task = parseClickUpTask(raw);
      return task ? [task] : [];
    });
    return { tasks, lastPage: body.last_page === true || tasks.length === 0 };
  }

  async listTasks(input: Omit<ListTasksPageInput, 'page'>): Promise<ClickUpTask[]> {
    const tasks: ClickUpTask[] = [];
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await this.listTasksPage({ ...input, page });
      tasks.push(...result.tasks);
      if (result.lastPage) break;
    }
    return tasks;
  }

  async getTask(taskId: string): Promise<ClickUpTask | null> {
    try {
      return parseClickUpTask(await this.#request('GET', `/task/${encodeURIComponent(taskId)}`));
    } catch (error) {
      if (error instanceof ClickUpApiError && (error.status === 404 || error.status === 403)) return null;
      throw error;
    }
  }

  async listComments(taskId: string): Promise<ClickUpComment[]> {
    const body = await this.#request('GET', `/task/${encodeURIComponent(taskId)}/comment`);
    return array(body.comments).map(raw => {
      const comment = record(raw);
      return {
        author: text(record(comment.user).username) || null,
        body: text(comment.comment_text),
        createdAt: isoFromEpoch(comment.date),
      };
    });
  }

  async createComment(taskId: string, body: string): Promise<{ id: string }> {
    const result = await this.#request('POST', `/task/${encodeURIComponent(taskId)}/comment`, {
      comment_text: body,
    });
    return { id: String(result.id ?? '') };
  }

  async setTaskStatus(taskId: string, status: string): Promise<void> {
    await this.#request('PUT', `/task/${encodeURIComponent(taskId)}`, { status });
  }

  async getList(listId: string): Promise<ClickUpListDetail> {
    const body = await this.#request('GET', `/list/${encodeURIComponent(listId)}`);
    return {
      id: text(body.id) || listId,
      name: text(body.name),
      statuses: array(body.statuses).map(raw => ({
        name: text(record(raw).status),
        type: text(record(raw).type),
      })),
    };
  }

  async listWorkspaces(): Promise<ClickUpWorkspace[]> {
    const body = await this.#request('GET', '/team');
    return array(body.teams).flatMap(raw => {
      const team = record(raw);
      const id = text(team.id);
      return id ? [{ id, name: text(team.name) || id }] : [];
    });
  }

  /**
   * Every non-archived List the token can reach in a Workspace, with the Space (and Folder) it
   * lives in. A guest or limited member is denied the Space hierarchy and sees only what was
   * shared with them, so that is read as well and the two are merged by List id.
   */
  async listLists(workspace: ClickUpWorkspace): Promise<ClickUpList[]> {
    const lists = new Map<string, ClickUpList>();
    const add = (raw: unknown, path: string) => {
      const list = record(raw);
      const id = text(list.id);
      if (id && !lists.has(id)) lists.set(id, { id, name: text(list.name) || id, path, workspaceId: workspace.id });
    };
    const addFolder = (rawFolder: unknown, prefix: string) => {
      const folder = record(rawFolder);
      const folderName = text(folder.name) || text(folder.id);
      // The folder payload already embeds its Lists.
      for (const rawList of array(folder.lists)) add(rawList, prefix ? `${prefix} / ${folderName}` : folderName);
    };

    for (const rawSpace of await this.#spaces(workspace)) {
      const space = record(rawSpace);
      const spaceId = text(space.id);
      if (!spaceId) continue;
      const spaceName = text(space.name) || spaceId;
      try {
        for (const rawList of array((await this.#request('GET', `/space/${spaceId}/list?archived=false`)).lists)) {
          add(rawList, spaceName);
        }
        for (const rawFolder of array((await this.#request('GET', `/space/${spaceId}/folder?archived=false`)).folders)) {
          addFolder(rawFolder, spaceName);
        }
      } catch (error) {
        if (!isAccessDenied(error)) throw error;
      }
    }

    try {
      const shared = record((await this.#request('GET', `/team/${workspace.id}/shared`)).shared);
      for (const rawFolder of array(shared.folders)) addFolder(rawFolder, '');
      for (const rawList of array(shared.lists)) add(rawList, SHARED_WITH_ME);
    } catch (error) {
      if (!isAccessDenied(error)) throw error;
    }
    return [...lists.values()];
  }

  async #spaces(workspace: ClickUpWorkspace): Promise<unknown[]> {
    try {
      return array((await this.#request('GET', `/team/${workspace.id}/space?archived=false`)).spaces);
    } catch (error) {
      if (isAccessDenied(error)) return [];
      throw error;
    }
  }

  async #request(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      method,
      headers: {
        Authorization: this.#token,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      const reset = response.headers.get('x-ratelimit-reset');
      const hint = response.status === 429 && reset ? ` Rate limit resets at ${reset}.` : '';
      throw new ClickUpApiError(`ClickUp request failed with ${response.status}.${hint}`, response.status);
    }
    return record(await response.json());
  }
}
