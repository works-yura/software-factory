import type { IntegrationStorageHandle } from '@factory/store';

import { ClickUpClient } from './api.ts';

/**
 * The organization's ClickUp connection (ADR-0032): its personal API token, stored encrypted in the
 * organization's `integration_connections` row. Nothing reads a token from the deployment's env.
 */
export interface ClickUpConnectionData {
  apiToken: string;
}

/** Shown on the settings page; never the token. */
export interface ClickUpConnectionMetadata {
  /** The ClickUp account the token belongs to. */
  username: string;
  userId: string;
  workspaces: string[];
}

export type ClickUpConnectionStorage = Pick<IntegrationStorageHandle, 'connections'>;

/** What Factory calls on ClickUp; `ClickUpClient` is the real one, tests pass their own. */
export type ClickUpApi = Pick<
  ClickUpClient,
  | 'listTasksPage'
  | 'listTasks'
  | 'getTask'
  | 'listComments'
  | 'listThreadComments'
  | 'listReplies'
  | 'replyToComment'
  | 'authorizedUser'
  | 'download'
  | 'createComment'
  | 'setTaskStatus'
  | 'getList'
  | 'listWorkspaces'
  | 'listLists'
>;

export type ClickUpClientFactory = (token: string) => ClickUpApi;

/** An organization that never connected ClickUp (or disconnected it) asked ClickUp for something. */
export class ClickUpNotConnectedError extends Error {
  readonly orgId: string;

  constructor(orgId: string) {
    super(`ClickUp is not connected for organization ${orgId}: an organization admin connects its token in Settings › Підключення › ClickUp.`);
    this.name = 'ClickUpNotConnectedError';
    this.orgId = orgId;
  }
}

export function clickUpTokenOf(data: unknown): string | null {
  const token = data && typeof data === 'object' ? (data as Record<string, unknown>).apiToken : undefined;
  return typeof token === 'string' && token.trim() ? token.trim() : null;
}

/** The organization's token, or `null` when it has not connected ClickUp. */
export async function readClickUpToken(storage: ClickUpConnectionStorage, orgId: string): Promise<string | null> {
  return clickUpTokenOf((await storage.connections.get(orgId))?.data);
}

export function clickUpMetadataOf(metadata: Record<string, unknown> | undefined): ClickUpConnectionMetadata | null {
  if (!metadata || typeof metadata.username !== 'string' || typeof metadata.userId !== 'string') return null;
  const workspaces = Array.isArray(metadata.workspaces) ? metadata.workspaces.filter((w): w is string => typeof w === 'string') : [];
  return { username: metadata.username, userId: metadata.userId, workspaces };
}

export async function saveClickUpConnection(
  storage: ClickUpConnectionStorage,
  orgId: string,
  input: { token: string; userId: string | null; account: ClickUpConnectionMetadata },
): Promise<void> {
  // A replaced token keeps the connection's own name and who first connected it.
  const previous = (await storage.connections.get(orgId))?.metadata ?? {};
  const kept = {
    ...(typeof previous.name === 'string' ? { name: previous.name } : {}),
    ...(typeof previous.connectedBy === 'string' ? { connectedBy: previous.connectedBy } : input.userId ? { connectedBy: input.userId } : {}),
  };
  await storage.connections.upsert(orgId, {
    userId: input.userId,
    data: { apiToken: input.token.trim() } satisfies ClickUpConnectionData,
    metadata: { ...input.account, ...kept },
  });
}

/**
 * Clients per organization, built from the organization's stored token. A client is kept while its
 * token stays the same, so a replaced token takes effect on the next call and a removed one stops
 * every call with {@link ClickUpNotConnectedError}.
 */
export class ClickUpClients {
  readonly #storage: () => ClickUpConnectionStorage;
  readonly #create: ClickUpClientFactory;
  readonly #byToken = new Map<string, ClickUpApi>();

  constructor(options: { storage: () => ClickUpConnectionStorage; create?: ClickUpClientFactory }) {
    this.#storage = options.storage;
    this.#create = options.create ?? (token => new ClickUpClient({ token }));
  }

  /** A client for a token the caller holds (an intake connection, a token being checked). */
  forToken(token: string): ClickUpApi {
    const key = token.trim();
    let client = this.#byToken.get(key);
    if (!client) {
      client = this.#create(key);
      this.#byToken.set(key, client);
    }
    return client;
  }

  /** The organization's client, or `null` when it has no token. */
  async forOrg(orgId: string): Promise<ClickUpApi | null> {
    const token = await readClickUpToken(this.#storage(), orgId);
    return token ? this.forToken(token) : null;
  }

  async require(orgId: string): Promise<ClickUpApi> {
    return this.forToken(await this.tokenOf(orgId));
  }

  /** The organization's token; {@link ClickUpNotConnectedError} when it has none. */
  async tokenOf(orgId: string): Promise<string> {
    const token = await readClickUpToken(this.#storage(), orgId);
    if (!token) throw new ClickUpNotConnectedError(orgId);
    return token;
  }

  /** Drops a client whose token was replaced or removed. */
  forget(token: string): void {
    this.#byToken.delete(token.trim());
  }
}

/**
 * The one-time move of the deployment's `CLICKUP_API_TOKEN` into the organization that owned all data
 * before organizations existed. Never overwrites a token the organization already stored; checks the
 * token's account so the settings page can name it. Returns a log line, or `undefined` when nothing
 * moved.
 */
export async function adoptDeploymentClickUpToken(options: {
  storage: ClickUpConnectionStorage;
  orgId: string;
  token: string | undefined;
  create?: ClickUpClientFactory;
}): Promise<string | undefined> {
  const token = options.token?.trim();
  if (!token) return undefined;
  if (await readClickUpToken(options.storage, options.orgId)) {
    return `kept the ClickUp token organization ${options.orgId} already stored; CLICKUP_API_TOKEN was not copied and is no longer read — delete it`;
  }
  const client = (options.create ?? (value => new ClickUpClient({ token: value })))(token);
  let account: ClickUpConnectionMetadata = { username: '', userId: '', workspaces: [] };
  try {
    const user = await client.authorizedUser();
    const workspaces = await client.listWorkspaces();
    account = { username: user.username, userId: user.id, workspaces: workspaces.map(w => w.name) };
  } catch (error) {
    // Stored anyway: losing the token would be worse than a connection the page shows as rejected.
    console.warn(
      `[clickup] CLICKUP_API_TOKEN could not be checked while moving it to organization ${options.orgId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  await saveClickUpConnection(options.storage, options.orgId, { token, userId: null, account });
  return `moved CLICKUP_API_TOKEN into organization ${options.orgId}'s ClickUp connection; the env var is no longer read — delete it`;
}
