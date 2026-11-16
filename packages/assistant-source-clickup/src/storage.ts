/**
 * The ClickUp source's own tables (ADR-0051 phase 2), all with the owner pair and every read and
 * delete scoped by both halves:
 *
 * - `assistant_source_connections` — the person's connection: the encrypted token, whose it is,
 *   the sync state (last sync, last error, failures, when to poll next) and their tag settings
 *   (pattern, who may tag, how many messages before a tag are its context);
 * - `assistant_source_channels` — each channel/DM the token sees, its read cursor (the newest
 *   top-level message looked at) and when the person last tagged there;
 * - `assistant_source_threads` — threads seen in a channel: replies count, the newest reply looked at.
 *
 * Only cursors and ids are kept: a message that carries no tag is looked at and dropped.
 *
 * Retired (ADR-0051 amendment 2026-11-16, the tag replaced the channel modes and rules): the
 * columns `assistant_source_channels.mode` / `.rule` and `assistant_source_threads.involves_me` are
 * no longer read. Schemas only ever add columns, so they stay: `mode` holds `retired`, `rule` null,
 * `involves_me` false. `init` migrates rows from before once (see `retireChannelModes`).
 */
import { assertOwner } from '@factory/assistant-core';
import type { AssistantOwner } from '@factory/assistant-core';

import type { ChannelLocationKind } from './client.ts';
import type { TagSettings, TagWho } from './tag.ts';
import { DEFAULT_TAG_SETTINGS, MAX_CONTEXT_MESSAGES } from './tag.ts';
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
      // The person's tag: their pattern (null: the default), who may tag (`me` / `anyone`; null: me),
      // and how many messages before a tag in a flat chat are its context (null: the default).
      tag_pattern: { type: 'text', nullable: true },
      tag_who: { type: 'text', nullable: true },
      tag_context: { type: 'integer', nullable: true },
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
      // Retired with the tag (see the file comment): `retired` on every row.
      mode: { type: 'text' },
      // Retired with the tag: always null.
      rule: { type: 'text', nullable: true },
      // What ClickUp says about it: in the person's sidebar (they follow it), a DM they hid,
      // PUBLIC/PRIVATE, and the Space/Folder/List a location channel belongs to.
      following: { type: 'boolean', nullable: true },
      hidden: { type: 'boolean', nullable: true },
      visibility: { type: 'text', nullable: true },
      location_kind: { type: 'text', nullable: true },
      location_id: { type: 'text', nullable: true },
      // Looked up once (and again after a day): the location's names, outermost first; a DM's other people.
      location_path: { type: 'json', nullable: true },
      members: { type: 'json', nullable: true },
      // The person is among the channel's followers (`…/followers`), as looked up; `null` until then.
      follower: { type: 'boolean', nullable: true },
      details_at: { type: 'timestamp', nullable: true },
      // Why the last lookup failed (`members:404`, `path:ECONNRESET` …); `null` when it worked.
      details_error: { type: 'text', nullable: true },
      // Epoch ms of the newest top-level message looked at; `null` until the first read (which only sets it).
      cursor_at: { type: 'bigint', nullable: true },
      // When the person last tagged the assistant here: the agent may read only such chats on demand.
      tagged_at: { type: 'timestamp', nullable: true },
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
      // Epoch ms of the newest reply looked at (0 = none yet).
      reply_cursor_at: { type: 'bigint' },
      // Retired with the tag: always false.
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

/** Another person in a DM, as the channel list shows them. */
export interface ChannelMember {
  id: string;
  name: string;
  avatarUrl: string | null;
}

/** What the channel listing knows of a channel besides its name and kind. */
export interface ChannelFacts {
  following: boolean;
  hidden: boolean;
  visibility: 'PUBLIC' | 'PRIVATE' | null;
  location: { kind: ChannelLocationKind; id: string } | null;
}

export type DetailsWhat = 'members' | 'path' | 'followers';

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
  tag: TagSettings;
}

export interface SourceChannel {
  workspaceId: string;
  channelId: string;
  name: string;
  kind: ChannelKind;
  following: boolean;
  hidden: boolean;
  visibility: 'PUBLIC' | 'PRIVATE' | null;
  location: { kind: ChannelLocationKind; id: string; path: string[] | null } | null;
  /** A DM's or group DM's other people, once looked up; `null` until then. */
  members: ChannelMember[] | null;
  /** The person is among the channel's followers (`…/followers`); `null` until looked up. */
  follower: boolean | null;
  /** Whether the listing ever said if the person follows it (`following` was stored); `false` on rows from before. */
  factsKnown: boolean;
  detailsAt: Date | null;
  /** Why the last lookup failed: `{ what: 'members' | 'path' | 'followers', code }`; `null` when it worked. */
  detailsError: { what: DetailsWhat; code: string } | null;
  cursorAt: number | null;
  /** When the person last tagged the assistant here; `null`: never. */
  taggedAt: Date | null;
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
  tag_pattern?: string | null;
  tag_who?: string | null;
  tag_context?: number | string | null;
}

interface ChannelRow extends Record<string, unknown> {
  workspace_id: string;
  channel_id: string;
  name: string;
  kind: string;
  following: unknown;
  hidden: unknown;
  visibility: string | null;
  location_kind: string | null;
  location_id: string | null;
  location_path: string[] | null;
  members: ChannelMember[] | null;
  follower?: unknown;
  details_at: Date | null;
  details_error?: string | null;
  cursor_at: number | string | null;
  tagged_at?: Date | null;
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
    tag: {
      pattern: typeof row.tag_pattern === 'string' && row.tag_pattern ? row.tag_pattern : null,
      who: row.tag_who === 'anyone' ? 'anyone' : 'me',
      contextMessages: contextCount(row.tag_context),
    },
  };
}

function contextCount(value: unknown): number {
  const count = Number(value);
  if (value === null || value === undefined || !Number.isInteger(count)) return DEFAULT_TAG_SETTINGS.contextMessages;
  return Math.min(Math.max(count, 0), MAX_CONTEXT_MESSAGES);
}

function parseDetailsError(value: unknown): SourceChannel['detailsError'] {
  if (typeof value !== 'string') return null;
  const match = /^(members|path|followers):(.+)$/.exec(value);
  return match ? { what: match[1] as DetailsWhat, code: match[2]! } : null;
}

function toChannel(row: ChannelRow): SourceChannel {
  return {
    workspaceId: row.workspace_id,
    channelId: row.channel_id,
    name: row.name,
    kind: row.kind === 'dm' || row.kind === 'group_dm' ? row.kind : 'channel',
    following: bool(row.following),
    hidden: bool(row.hidden),
    visibility: row.visibility === 'PUBLIC' || row.visibility === 'PRIVATE' ? row.visibility : null,
    location:
      (row.location_kind === 'space' || row.location_kind === 'folder' || row.location_kind === 'list') && row.location_id
        ? { kind: row.location_kind, id: row.location_id, path: Array.isArray(row.location_path) ? row.location_path : null }
        : null,
    members: Array.isArray(row.members) ? row.members : null,
    follower: row.follower === null || row.follower === undefined ? null : bool(row.follower),
    factsKnown: row.following !== null && row.following !== undefined,
    detailsAt: row.details_at ?? null,
    detailsError: parseDetailsError(row.details_error),
    cursorAt: row.cursor_at === null || row.cursor_at === undefined ? null : Number(row.cursor_at),
    taggedAt: row.tagged_at ?? null,
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

/** The value the retired `mode` column holds (it is NOT NULL in tables from before). */
export const RETIRED_MODE = 'retired';

export class ClickUpSourceStorage extends FactoryStorageDomain {
  constructor() {
    super('assistant_source_clickup');
  }

  async init(): Promise<void> {
    await this.ensureCollections(SOURCE_SCHEMAS);
    await this.retireChannelModes();
  }

  /**
   * The one-time migration to the tag (ADR-0051 amendment 2026-11-16): rows that still carry a
   * channel mode (`ignore` / `addressed` / `watch`) lose it and their rule, and their cursors move
   * to the switch: nothing written before it (in a chat that was off, possibly long ago) is ever
   * looked at for a tag, and a tag written after it is found on the chat's next read. Rows already
   * migrated are not touched again. Returns how many rows it migrated.
   */
  async retireChannelModes(now = new Date()): Promise<number> {
    const migrated = await this.ops.updateMany(
      SOURCE_CHANNELS,
      { mode: { in: ['ignore', 'addressed', 'watch'] } },
      { mode: RETIRED_MODE, rule: null, cursor_at: now.getTime(), last_error: null, updated_at: now },
    );
    // Threads followed before the switch: their replies so far were written before it, too.
    if (migrated > 0) await this.ops.updateMany(SOURCE_THREADS, {}, { reply_cursor_at: now.getTime(), updated_at: now });
    return migrated;
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

  /** Sets the person's tag: pattern (`null`: the default), who may tag, context messages. */
  async setTag(o: AssistantOwner, tag: Partial<TagSettings>, now = new Date()): Promise<void> {
    const set: Record<string, unknown> = { updated_at: now };
    if (tag.pattern !== undefined) set.tag_pattern = tag.pattern;
    if (tag.who !== undefined) set.tag_who = tag.who satisfies TagWho;
    if (tag.contextMessages !== undefined) set.tag_context = tag.contextMessages;
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
   * Brings the channel list up to what ClickUp lists: new channels are added (their first read
   * only sets the cursor), known ones get the current name, ones no longer listed are marked gone
   * (their cursor is kept should they come back).
   */
  async syncChannels(
    o: AssistantOwner,
    listed: Array<{ workspaceId: string; channelId: string; name: string; kind: ChannelKind } & ChannelFacts>,
    now = new Date(),
  ): Promise<void> {
    const w = where(o);
    const known = new Map((await this.listChannels(o)).map(channel => [`${channel.workspaceId}\u0000${channel.channelId}`, channel]));
    for (const channel of listed) {
      const key = `${channel.workspaceId}\u0000${channel.channelId}`;
      const existing = known.get(key);
      known.delete(key);
      const target = { ...w, workspace_id: channel.workspaceId, channel_id: channel.channelId };
      const facts = {
        following: channel.following,
        hidden: channel.hidden,
        visibility: channel.visibility,
        location_kind: channel.location?.kind ?? null,
        location_id: channel.location?.id ?? null,
      };
      if (existing) {
        const movedLocation = existing.location?.id !== channel.location?.id;
        if (
          existing.name !== channel.name ||
          existing.gone ||
          existing.kind !== channel.kind ||
          existing.following !== channel.following ||
          existing.hidden !== channel.hidden ||
          existing.visibility !== channel.visibility ||
          movedLocation
        ) {
          await this.ops.updateAtomic<ChannelRow>(SOURCE_CHANNELS, target, () => ({
            name: channel.name,
            kind: channel.kind,
            gone: false,
            ...facts,
            // A channel that moved to another location gets its path looked up again.
            ...(movedLocation ? { location_path: null, details_at: null } : {}),
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
          mode: RETIRED_MODE,
          rule: null,
          ...facts,
          location_path: null,
          members: null,
          follower: null,
          details_at: null,
          details_error: null,
          cursor_at: null,
          tagged_at: null,
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

  /** What was looked up about a channel: a location's path, a DM's other people. */
  async setDetails(
    o: AssistantOwner,
    workspaceId: string,
    channelId: string,
    details: { path?: string[]; members?: ChannelMember[]; follower?: boolean; error?: { what: DetailsWhat; code: string } | null },
    now = new Date(),
  ): Promise<void> {
    await this.ops.updateAtomic<ChannelRow>(SOURCE_CHANNELS, { ...where(o), workspace_id: workspaceId, channel_id: channelId }, () => ({
      ...(details.path ? { location_path: details.path } : {}),
      ...(details.members ? { members: details.members } : {}),
      ...(details.follower !== undefined ? { follower: details.follower } : {}),
      details_error: details.error ? `${details.error.what}:${details.error.code}`.slice(0, 80) : null,
      details_at: now,
      updated_at: now,
    }));
  }

  async patchChannel(
    o: AssistantOwner,
    workspaceId: string,
    channelId: string,
    patch: { cursorAt?: number; taggedAt?: Date; lastSyncAt?: Date; lastError?: string | null },
    now = new Date(),
  ): Promise<void> {
    const set: Record<string, unknown> = { updated_at: now };
    if (patch.cursorAt !== undefined) set.cursor_at = patch.cursorAt;
    if (patch.taggedAt !== undefined) set.tagged_at = patch.taggedAt;
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
      updated_at: now,
    };
    if (await this.ops.updateAtomic<ThreadRow>(SOURCE_THREADS, target, () => set)) return;
    try {
      await this.ops.insertOne<ThreadRow>(SOURCE_THREADS, { ...target, ...set, involves_me: false } as Partial<ThreadRow>);
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
