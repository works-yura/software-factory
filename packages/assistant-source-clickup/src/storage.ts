/**
 * The ClickUp source's own tables (ADR-0051 phase 2), all with the owner pair and every read and
 * delete scoped by both halves:
 *
 * - `assistant_source_connections` — the person's connection: the encrypted token, whose it is,
 *   the sync state (last sync, last error, failures, when to poll next);
 * - `assistant_source_channels` — each channel/DM the token sees, with the person's mode and the
 *   read cursor (the newest top-level message taken);
 * - `assistant_source_threads` — threads seen in a channel: replies count, the newest reply taken,
 *   whether the person is in it (for «only when addressed»).
 */
import { assertOwner } from '@factory/assistant-core';
import type { AssistantOwner, ChannelMode } from '@factory/assistant-core';
import { FactoryStorageDomain, UniqueViolationError } from '@mastra/core/storage';
import type { CollectionSchema, CollectionWhere } from '@mastra/core/storage';

export const SOURCE_CONNECTIONS = 'assistant_source_connections';
export const SOURCE_CHANNELS = 'assistant_source_channels';
export const SOURCE_THREADS = 'assistant_source_threads';

export const PLATFORM = 'clickup';

const owner = { owner_org_id: { type: 'text' }, owner_user_id: { type: 'text' } } as const;

export const SOURCE_SCHEMAS: CollectionSchema[] = [
  {
    name: SOURCE_CONNECTIONS,
    columns: {
      id: { type: 'uuid-pk' },
      ...owner,
      platform: { type: 'text' },
      // The token, in the `secret-encryption` envelope. Never returned by any route.
      secret: { type: 'text' },
      account_id: { type: 'text' },
      account_name: { type: 'text' },
      // `active` polls; `rejected` (ClickUp refused the token) waits for the person to connect again.
      status: { type: 'text' },
      last_sync_at: { type: 'timestamp', nullable: true },
      last_error: { type: 'text', nullable: true },
      failures: { type: 'integer' },
      next_poll_at: { type: 'timestamp', nullable: true },
      channels_listed_at: { type: 'timestamp', nullable: true },
      created_at: { type: 'timestamp' },
      updated_at: { type: 'timestamp' },
    },
    uniqueIndexes: [{ name: 'assistant_source_connections_owner_key', columns: ['owner_org_id', 'owner_user_id', 'platform'] }],
    indexes: [{ name: 'assistant_source_connections_due_idx', columns: ['platform', 'status', 'next_poll_at'] }],
  },
  {
    name: SOURCE_CHANNELS,
    columns: {
      id: { type: 'uuid-pk' },
      ...owner,
      platform: { type: 'text' },
      workspace_id: { type: 'text' },
      channel_id: { type: 'text' },
      name: { type: 'text' },
      // `channel`, `dm`, `group_dm`
      kind: { type: 'text' },
      mode: { type: 'text' },
      // Epoch ms of the newest top-level message taken; `null` until the first read after enabling.
      cursor_at: { type: 'bigint', nullable: true },
      last_sync_at: { type: 'timestamp', nullable: true },
      last_error: { type: 'text', nullable: true },
      gone: { type: 'boolean' },
      created_at: { type: 'timestamp' },
      updated_at: { type: 'timestamp' },
    },
    uniqueIndexes: [
      {
        name: 'assistant_source_channels_key',
        columns: ['owner_org_id', 'owner_user_id', 'platform', 'workspace_id', 'channel_id'],
      },
    ],
  },
  {
    name: SOURCE_THREADS,
    columns: {
      id: { type: 'uuid-pk' },
      ...owner,
      platform: { type: 'text' },
      workspace_id: { type: 'text' },
      channel_id: { type: 'text' },
      message_id: { type: 'text' },
      root_at: { type: 'bigint' },
      replies_count: { type: 'integer' },
      // Epoch ms of the newest reply taken (0 = none yet).
      reply_cursor_at: { type: 'bigint' },
      involves_me: { type: 'boolean' },
      updated_at: { type: 'timestamp' },
    },
    uniqueIndexes: [
      {
        name: 'assistant_source_threads_key',
        columns: ['owner_org_id', 'owner_user_id', 'platform', 'workspace_id', 'message_id'],
      },
    ],
    indexes: [{ name: 'assistant_source_threads_channel_idx', columns: ['owner_org_id', 'owner_user_id', 'channel_id'] }],
  },
];

const OWNER_TABLES = [SOURCE_THREADS, SOURCE_CHANNELS, SOURCE_CONNECTIONS] as const;

export type ChannelKind = 'channel' | 'dm' | 'group_dm';

export interface SourceConnection {
  owner: AssistantOwner;
  secret: string;
  accountId: string;
  accountName: string;
  status: 'active' | 'rejected';
  lastSyncAt: Date | null;
  lastError: string | null;
  failures: number;
  nextPollAt: Date | null;
  channelsListedAt: Date | null;
}

export interface SourceChannel {
  workspaceId: string;
  channelId: string;
  name: string;
  kind: ChannelKind;
  mode: ChannelMode;
  cursorAt: number | null;
  lastSyncAt: Date | null;
  lastError: string | null;
  gone: boolean;
}

export interface SourceThread {
  workspaceId: string;
  channelId: string;
  messageId: string;
  rootAt: number;
  repliesCount: number;
  replyCursorAt: number;
  involvesMe: boolean;
}

interface ConnectionRow extends Record<string, unknown> {
  owner_org_id: string;
  owner_user_id: string;
  secret: string;
  account_id: string;
  account_name: string;
  status: string;
  last_sync_at: Date | null;
  last_error: string | null;
  failures: number;
  next_poll_at: Date | null;
  channels_listed_at: Date | null;
}

interface ChannelRow extends Record<string, unknown> {
  workspace_id: string;
  channel_id: string;
  name: string;
  kind: string;
  mode: string;
  cursor_at: number | string | null;
  last_sync_at: Date | null;
  last_error: string | null;
  gone: unknown;
}

interface ThreadRow extends Record<string, unknown> {
  workspace_id: string;
  channel_id: string;
  message_id: string;
  root_at: number | string;
  replies_count: number;
  reply_cursor_at: number | string;
  involves_me: unknown;
}

function where(o: AssistantOwner): CollectionWhere {
  assertOwner(o);
  return { owner_org_id: o.orgId, owner_user_id: o.userId, platform: PLATFORM };
}

function bool(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function toConnection(row: ConnectionRow): SourceConnection {
  return {
    owner: { orgId: row.owner_org_id, userId: row.owner_user_id },
    secret: row.secret,
    accountId: row.account_id,
    accountName: row.account_name,
    status: row.status === 'rejected' ? 'rejected' : 'active',
    lastSyncAt: row.last_sync_at,
    lastError: row.last_error,
    failures: Number(row.failures) || 0,
    nextPollAt: row.next_poll_at,
    channelsListedAt: row.channels_listed_at,
  };
}

function toChannel(row: ChannelRow): SourceChannel {
  return {
    workspaceId: row.workspace_id,
    channelId: row.channel_id,
    name: row.name,
    kind: row.kind === 'dm' || row.kind === 'group_dm' ? row.kind : 'channel',
    mode: row.mode === 'watch' || row.mode === 'addressed' ? row.mode : 'ignore',
    cursorAt: row.cursor_at === null || row.cursor_at === undefined ? null : Number(row.cursor_at),
    lastSyncAt: row.last_sync_at,
    lastError: row.last_error,
    gone: bool(row.gone),
  };
}

function toThread(row: ThreadRow): SourceThread {
  return {
    workspaceId: row.workspace_id,
    channelId: row.channel_id,
    messageId: row.message_id,
    rootAt: Number(row.root_at),
    repliesCount: Number(row.replies_count) || 0,
    replyCursorAt: Number(row.reply_cursor_at) || 0,
    involvesMe: bool(row.involves_me),
  };
}

export interface ConnectionPatch {
  status?: 'active' | 'rejected';
  lastSyncAt?: Date | null;
  lastError?: string | null;
  failures?: number;
  nextPollAt?: Date | null;
  channelsListedAt?: Date | null;
}

export class ClickUpSourceStorage extends FactoryStorageDomain {
  constructor() {
    super('assistant_source_clickup');
  }

  async init(): Promise<void> {
    await this.ensureCollections(SOURCE_SCHEMAS);
  }

  async dangerouslyClearAll(): Promise<void> {
    for (const schema of SOURCE_SCHEMAS) await this.ops.deleteMany(schema.name, {});
  }

  // Connection

  async getConnection(o: AssistantOwner): Promise<SourceConnection | null> {
    const row = await this.ops.findOne<ConnectionRow>(SOURCE_CONNECTIONS, where(o));
    return row ? toConnection(row) : null;
  }

  /** Creates or replaces the person's connection (a new token starts afresh: active, due now). */
  async putConnection(
    o: AssistantOwner,
    input: { secret: string; accountId: string; accountName: string },
    now = new Date(),
  ): Promise<void> {
    const w = where(o);
    const set = {
      secret: input.secret,
      account_id: input.accountId,
      account_name: input.accountName,
      status: 'active',
      last_error: null,
      failures: 0,
      next_poll_at: now,
      updated_at: now,
    };
    if (await this.ops.updateAtomic<ConnectionRow>(SOURCE_CONNECTIONS, w, () => set)) return;
    try {
      await this.ops.insertOne<ConnectionRow>(SOURCE_CONNECTIONS, {
        ...w,
        ...set,
        last_sync_at: null,
        channels_listed_at: null,
        created_at: now,
      } as Partial<ConnectionRow>);
    } catch (error) {
      if (!(error instanceof UniqueViolationError)) throw error;
      await this.ops.updateAtomic<ConnectionRow>(SOURCE_CONNECTIONS, w, () => set);
    }
  }

  async patchConnection(o: AssistantOwner, patch: ConnectionPatch, now = new Date()): Promise<void> {
    const set: Record<string, unknown> = { updated_at: now };
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.lastSyncAt !== undefined) set.last_sync_at = patch.lastSyncAt;
    if (patch.lastError !== undefined) set.last_error = patch.lastError;
    if (patch.failures !== undefined) set.failures = patch.failures;
    if (patch.nextPollAt !== undefined) set.next_poll_at = patch.nextPollAt;
    if (patch.channelsListedAt !== undefined) set.channels_listed_at = patch.channelsListedAt;
    await this.ops.updateAtomic<ConnectionRow>(SOURCE_CONNECTIONS, where(o), () => set as Partial<ConnectionRow>);
  }

  /** Active connections due a poll, the most overdue first. */
  async dueConnections(now: Date, limit: number): Promise<SourceConnection[]> {
    const rows = await this.ops.findMany<ConnectionRow>(
      SOURCE_CONNECTIONS,
      { platform: PLATFORM, status: 'active' },
      { orderBy: [['next_poll_at', 'asc']] },
    );
    return rows
      .map(toConnection)
      .filter(connection => connection.nextPollAt !== null && connection.nextPollAt.getTime() <= now.getTime())
      .slice(0, limit);
  }

  // Channels

  async listChannels(o: AssistantOwner): Promise<SourceChannel[]> {
    const rows = await this.ops.findMany<ChannelRow>(SOURCE_CHANNELS, where(o), {
      orderBy: [
        ['kind', 'asc'],
        ['name', 'asc'],
      ],
    });
    return rows.map(toChannel);
  }

  async getChannel(o: AssistantOwner, workspaceId: string, channelId: string): Promise<SourceChannel | null> {
    const row = await this.ops.findOne<ChannelRow>(SOURCE_CHANNELS, { ...where(o), workspace_id: workspaceId, channel_id: channelId });
    return row ? toChannel(row) : null;
  }

  /**
   * Brings the channel list up to what ClickUp lists: new channels get their default mode, known
   * ones keep the person's mode and get the current name, ones no longer listed are marked gone
   * (their mode is kept should they come back).
   */
  async syncChannels(
    o: AssistantOwner,
    listed: Array<{ workspaceId: string; channelId: string; name: string; kind: ChannelKind; defaultMode: ChannelMode }>,
    now = new Date(),
  ): Promise<void> {
    const w = where(o);
    const known = new Map((await this.listChannels(o)).map(channel => [`${channel.workspaceId}\u0000${channel.channelId}`, channel]));
    for (const channel of listed) {
      const key = `${channel.workspaceId}\u0000${channel.channelId}`;
      const existing = known.get(key);
      known.delete(key);
      const target = { ...w, workspace_id: channel.workspaceId, channel_id: channel.channelId };
      if (existing) {
        if (existing.name !== channel.name || existing.gone || existing.kind !== channel.kind) {
          await this.ops.updateAtomic<ChannelRow>(SOURCE_CHANNELS, target, () => ({
            name: channel.name,
            kind: channel.kind,
            gone: false,
            updated_at: now,
          }));
        }
        continue;
      }
      try {
        await this.ops.insertOne<ChannelRow>(SOURCE_CHANNELS, {
          ...target,
          name: channel.name,
          kind: channel.kind,
          mode: channel.defaultMode,
          cursor_at: null,
          last_sync_at: null,
          last_error: null,
          gone: false,
          created_at: now,
          updated_at: now,
        } as Partial<ChannelRow>);
      } catch (error) {
        if (!(error instanceof UniqueViolationError)) throw error;
      }
    }
    for (const channel of known.values()) {
      if (channel.gone) continue;
      await this.ops.updateAtomic<ChannelRow>(
        SOURCE_CHANNELS,
        { ...w, workspace_id: channel.workspaceId, channel_id: channel.channelId },
        () => ({ gone: true, updated_at: now }),
      );
    }
  }

  /**
   * Sets a channel's mode. Turning reading on (from `ignore`) restarts its cursor, so only what is
   * written from now on is read — never the channel's history.
   */
  async setMode(o: AssistantOwner, workspaceId: string, channelId: string, mode: ChannelMode, now = new Date()) {
    const target = { ...where(o), workspace_id: workspaceId, channel_id: channelId };
    const current = await this.ops.findOne<ChannelRow>(SOURCE_CHANNELS, target);
    if (!current) return null;
    const restart = mode !== 'ignore' && toChannel(current).mode === 'ignore';
    const row = await this.ops.updateAtomic<ChannelRow>(SOURCE_CHANNELS, target, () => ({
      mode,
      ...(restart ? { cursor_at: null, last_error: null } : {}),
      updated_at: now,
    }));
    return row ? toChannel(row) : null;
  }

  async patchChannel(
    o: AssistantOwner,
    workspaceId: string,
    channelId: string,
    patch: { cursorAt?: number; lastSyncAt?: Date; lastError?: string | null },
    now = new Date(),
  ): Promise<void> {
    const set: Record<string, unknown> = { updated_at: now };
    if (patch.cursorAt !== undefined) set.cursor_at = patch.cursorAt;
    if (patch.lastSyncAt !== undefined) set.last_sync_at = patch.lastSyncAt;
    if (patch.lastError !== undefined) set.last_error = patch.lastError;
    await this.ops.updateAtomic<ChannelRow>(
      SOURCE_CHANNELS,
      { ...where(o), workspace_id: workspaceId, channel_id: channelId },
      () => set as Partial<ChannelRow>,
    );
  }

  // Threads

  async getThread(o: AssistantOwner, workspaceId: string, messageId: string): Promise<SourceThread | null> {
    const row = await this.ops.findOne<ThreadRow>(SOURCE_THREADS, { ...where(o), workspace_id: workspaceId, message_id: messageId });
    return row ? toThread(row) : null;
  }

  async putThread(o: AssistantOwner, thread: SourceThread, now = new Date()): Promise<void> {
    const target = { ...where(o), workspace_id: thread.workspaceId, message_id: thread.messageId };
    const set = {
      channel_id: thread.channelId,
      root_at: thread.rootAt,
      replies_count: thread.repliesCount,
      reply_cursor_at: thread.replyCursorAt,
      involves_me: thread.involvesMe,
      updated_at: now,
    };
    if (await this.ops.updateAtomic<ThreadRow>(SOURCE_THREADS, target, () => set)) return;
    try {
      await this.ops.insertOne<ThreadRow>(SOURCE_THREADS, { ...target, ...set } as Partial<ThreadRow>);
    } catch (error) {
      if (!(error instanceof UniqueViolationError)) throw error;
      await this.ops.updateAtomic<ThreadRow>(SOURCE_THREADS, target, () => set);
    }
  }

  /** Forgets threads whose root is older than `before` (epoch ms): they are no longer followed. */
  async pruneThreads(o: AssistantOwner, before: number): Promise<void> {
    const rows = await this.ops.findMany<ThreadRow>(SOURCE_THREADS, where(o));
    for (const row of rows) {
      if (Number(row.root_at) < before) {
        await this.ops.deleteMany(SOURCE_THREADS, { ...where(o), workspace_id: row.workspace_id, message_id: row.message_id });
      }
    }
  }

  // Cleanup

  /** The connection (its encrypted token first), channels and threads of one owner. */
  async deleteOwner(o: AssistantOwner): Promise<void> {
    for (const table of [SOURCE_CONNECTIONS, ...OWNER_TABLES.filter(t => t !== SOURCE_CONNECTIONS)]) {
      await this.ops.deleteMany(table, where(o));
    }
  }

  async organizationsOf(userId: string): Promise<string[]> {
    if (!userId?.trim()) throw new Error('A user id is required.');
    const orgs = new Set<string>();
    for (const table of OWNER_TABLES) {
      const rows = await this.ops.findMany<{ owner_org_id: string }>(table, { owner_user_id: userId, platform: PLATFORM });
      for (const row of rows) orgs.add(row.owner_org_id);
    }
    return [...orgs];
  }
}
