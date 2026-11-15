/**
 * ClickUp Chat as a personal source of «Помічник» (ADR-0051 phase 2): the person connects their
 * own personal API token; the assistant lists the channels and DMs it sees, reads the ones the
 * person turned on (a mode per channel), and turns threads into requests through the core's
 * `ingestSourceMessage` (binding key `clickup:<workspace>:<channel>:<root message>`, idempotent by
 * message id). It never writes to ClickUp.
 */
import { AssistantError, ASSISTANT_FILE_MAX_BYTES } from '@factory/assistant-core';
import type { AssistantOwner, AssistantSource, ChannelMode, SecretCipher, SourceMessage } from '@factory/assistant-core';

import type { ChatChannel, ChatMessage, ClickUpChatClientOptions } from './client.ts';
import { channelUrl, ClickUpBudgetSpent, ClickUpChatClient, ClickUpChatError, fileLinks, isPersonalToken } from './client.ts';
import type { OrgClickUpReader } from './org-connection.ts';
import { orgConnectionFor } from './org-connection.ts';
import type { ChannelKind, ClickUpSourceStorage, SourceChannel, SourceConnection } from './storage.ts';
import { PLATFORM } from './storage.ts';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** How often and how much one person's ClickUp is read: the cost guard. */
export interface ClickUpPollLimits {
  /** Between two polls of one person. */
  intervalMs: number;
  /** The longest wait after repeated failures (the backoff doubles up to it). */
  maxBackoffMs: number;
  /** ClickUp calls one poll may make (ClickUp allows 100 a minute per token on most plans). */
  callsPerPoll: number;
  /** Channels read in one poll; the rest are read next time, least recently read first. */
  channelsPerPoll: number;
  /** Pages of top-level messages read back per channel in one poll. */
  pagesPerChannel: number;
  /** Agent turns per person per hour; past it, messages are kept but not analysed. */
  turnsPerHour: number;
  /** The channel list is read again this often. */
  channelsRefreshMs: number;
  /** Threads older than this stop being followed for replies. */
  followThreadsMs: number;
}

export const DEFAULT_POLL_LIMITS: ClickUpPollLimits = {
  intervalMs: 2 * MINUTE,
  maxBackoffMs: 30 * MINUTE,
  callsPerPoll: 40,
  channelsPerPoll: 10,
  pagesPerChannel: 3,
  turnsPerHour: 20,
  channelsRefreshMs: 60 * MINUTE,
  followThreadsMs: 14 * DAY,
};

/** What the source needs from the core: taking messages in, and which threads have open requests. */
export interface SourceIngest {
  ingestSourceMessage(owner: AssistantOwner, message: SourceMessage): Promise<{ outcome: string }>;
  hasOpenSourceRequest(owner: AssistantOwner, sourceKey: string): Promise<boolean>;
}

export interface ClickUpSourceDeps {
  storage: ClickUpSourceStorage;
  cipher: SecretCipher;
  ingest: SourceIngest;
  /** Builds the client for a token; tests give a fake `fetch`. */
  client?: (options: ClickUpChatClientOptions) => ClickUpChatClient;
  limits?: Partial<ClickUpPollLimits>;
  /**
   * The organization's ClickUp connection (Settings › Підключення), offered to the one person whose
   * own account its token is; absent, everyone connects a personal token.
   */
  orgClickUp?: OrgClickUpReader;
  maxFileBytes?: number;
  now?: () => Date;
}

/** The default mode of a channel the person has not set: DMs are read when addressed, channels not at all. */
export function defaultMode(kind: ChannelKind): ChannelMode {
  return kind === 'channel' ? 'ignore' : 'addressed';
}

function kindOf(channel: ChatChannel): ChannelKind {
  return channel.type === 'DM' ? 'dm' : channel.type === 'GROUP_DM' ? 'group_dm' : 'channel';
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface PollResult {
  /** Messages taken in (new requests and follow-ups). */
  ingested: number;
  /** Channels read. */
  channels: number;
  calls: number;
  error?: string;
}

/** The person's connection as the settings show it: never the token. */
export interface ConnectionView {
  connected: boolean;
  /** Read with the person's own personal token, or with the organization's connection (their own account). */
  via: 'personal' | 'org' | null;
  /**
   * The organization's ClickUp connection, offered only to the person whose ClickUp account its token
   * is (proved by an identity link or by having saved it); `null` for everyone else.
   */
  orgOffer: { accountName: string; workspaces: string[] } | null;
  account: { id: string; name: string } | null;
  status: 'active' | 'rejected' | null;
  lastSyncAt: string | null;
  lastError: string | null;
  nextPollAt: string | null;
  channels: Array<{
    workspaceId: string;
    channelId: string;
    name: string;
    kind: ChannelKind;
    mode: ChannelMode;
    lastSyncAt: string | null;
    lastError: string | null;
  }>;
}

/** What the stored secret holds: the person's own token, or a pointer to the organization's connection. */
type StoredSecret = { token: string } | { org: true };

export const ORG_CONNECTION_GONE =
  "The organization's ClickUp connection was removed or is no longer your account, so the assistant stopped reading ClickUp. Connect your own personal token.";

/** Sliding one-hour window of agent turns per person. In memory: a restart forgives, never overspends much. */
class TurnLimiter {
  readonly #turns = new Map<string, number[]>();
  allow(owner: AssistantOwner, limit: number, now: number): boolean {
    const key = `${owner.orgId}\u0000${owner.userId}`;
    const recent = (this.#turns.get(key) ?? []).filter(at => now - at < 60 * MINUTE);
    if (recent.length >= limit) {
      this.#turns.set(key, recent);
      return false;
    }
    recent.push(now);
    this.#turns.set(key, recent);
    return true;
  }
  forget(owner: AssistantOwner) {
    this.#turns.delete(`${owner.orgId}\u0000${owner.userId}`);
  }
}

export class ClickUpChatSource implements AssistantSource {
  readonly platform = PLATFORM;
  readonly limits: ClickUpPollLimits;
  readonly #deps: ClickUpSourceDeps;
  readonly #now: () => Date;
  readonly #turns = new TurnLimiter();
  /** One poll per person at a time. */
  readonly #polling = new Map<string, Promise<PollResult>>();

  constructor(deps: ClickUpSourceDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? (() => new Date());
    this.limits = { ...DEFAULT_POLL_LIMITS, ...deps.limits };
  }

  #client(token: string, budget?: number): ClickUpChatClient {
    const options: ClickUpChatClientOptions = { token, ...(budget !== undefined ? { budget } : {}) };
    return this.#deps.client ? this.#deps.client(options) : new ClickUpChatClient(options);
  }

  async #ready() {
    await this.#deps.storage.ensureReady();
  }

  // Connecting

  /**
   * Connects the person's own personal API token: checks it with ClickUp (whose it is, which
   * workspaces), stores it encrypted, and lists the channels. Nothing is read until a channel is on;
   * DMs are on «only when addressed» by default, channels off.
   */
  async connect(owner: AssistantOwner, rawToken: string): Promise<ConnectionView> {
    await this.#ready();
    const token = (rawToken ?? '').trim();
    if (!isPersonalToken(token)) {
      throw new AssistantError(
        'invalid_token',
        'Paste a ClickUp personal API token (it starts with pk_). ClickUp › Settings › Apps › API Token.',
        400,
      );
    }
    const client = this.#client(token);
    let me;
    try {
      me = await client.me();
    } catch (error) {
      if (error instanceof ClickUpChatError && (error.status === 401 || error.status === 403)) {
        throw new AssistantError('token_rejected', 'ClickUp did not accept this token.', 400);
      }
      throw new AssistantError('clickup_failed', `ClickUp answered: ${errorText(error)}`, 502);
    }
    await this.#deps.storage.putConnection(
      owner,
      { secret: await this.#deps.cipher.encrypt({ token }), accountId: me.id, accountName: me.username || me.email || me.id },
      this.#now(),
    );
    try {
      await this.#listChannels(owner, client);
    } catch (error) {
      await this.#deps.storage.patchConnection(owner, { lastError: errorText(error) }, this.#now());
    }
    return this.view(owner);
  }

  /**
   * Reads ClickUp with the organization's connection instead of a pasted token — only for the person
   * whose own ClickUp account that token is. Nothing of the token is copied: each read takes the
   * organization's current token and checks the proof again.
   */
  async connectOrg(owner: AssistantOwner): Promise<ConnectionView> {
    await this.#ready();
    const offered = this.#deps.orgClickUp ? await orgConnectionFor(this.#deps.orgClickUp, owner) : null;
    if (!offered) {
      throw new AssistantError(
        'org_connection_not_yours',
        "The organization's ClickUp connection is not your ClickUp account. Connect your own personal token.",
        403,
      );
    }
    const { account, token } = offered.connection;
    await this.#deps.storage.putConnection(
      owner,
      { secret: await this.#deps.cipher.encrypt<StoredSecret>({ org: true }), accountId: account.id, accountName: account.name },
      this.#now(),
    );
    try {
      await this.#listChannels(owner, this.#client(token));
    } catch (error) {
      await this.#deps.storage.patchConnection(owner, { lastError: errorText(error) }, this.#now());
    }
    return this.view(owner);
  }

  /** The token a read uses: the person's own, or the organization's while it is still provably theirs. */
  async #token(owner: AssistantOwner, connection: SourceConnection): Promise<{ token: string; via: 'personal' | 'org' } | null> {
    const { value } = await this.#deps.cipher.decrypt<StoredSecret>(connection.secret);
    if ('token' in value) return { token: value.token, via: 'personal' };
    const offered = this.#deps.orgClickUp ? await orgConnectionFor(this.#deps.orgClickUp, owner) : null;
    return offered ? { token: offered.connection.token, via: 'org' } : null;
  }

  async #via(connection: SourceConnection): Promise<'personal' | 'org'> {
    const { value } = await this.#deps.cipher.decrypt<StoredSecret>(connection.secret);
    return 'token' in value ? 'personal' : 'org';
  }

  /** Forgets the connection, channel modes and cursors (the token first). Requests stay the person's. */
  async disconnect(owner: AssistantOwner): Promise<void> {
    await this.#ready();
    await this.#deps.storage.deleteOwner(owner);
    this.#turns.forget(owner);
  }

  async organizationsOf(userId: string): Promise<string[]> {
    await this.#ready();
    return this.#deps.storage.organizationsOf(userId);
  }

  async view(owner: AssistantOwner): Promise<ConnectionView> {
    await this.#ready();
    const connection = await this.#deps.storage.getConnection(owner);
    const offered = this.#deps.orgClickUp ? await orgConnectionFor(this.#deps.orgClickUp, owner) : null;
    const orgOffer = offered ? { accountName: offered.connection.account.name, workspaces: offered.connection.account.workspaces } : null;
    if (!connection) {
      return {
        connected: false,
        via: null,
        orgOffer,
        account: null,
        status: null,
        lastSyncAt: null,
        lastError: null,
        nextPollAt: null,
        channels: [],
      };
    }
    const via = await this.#via(connection);
    // DMs first (they are what reaches the person), then channels, each by name.
    const order: Record<ChannelKind, number> = { dm: 0, group_dm: 1, channel: 2 };
    const channels = (await this.#deps.storage.listChannels(owner))
      .filter(channel => !channel.gone)
      .sort((a, b) => order[a.kind] - order[b.kind] || a.name.localeCompare(b.name));
    return {
      connected: true,
      via,
      orgOffer: via === 'org' ? null : orgOffer,
      account: { id: connection.accountId, name: connection.accountName },
      status: connection.status,
      lastSyncAt: connection.lastSyncAt?.toISOString() ?? null,
      lastError: connection.lastError,
      nextPollAt: connection.nextPollAt?.toISOString() ?? null,
      channels: channels.map(channel => ({
        workspaceId: channel.workspaceId,
        channelId: channel.channelId,
        name: channel.name,
        kind: channel.kind,
        mode: channel.mode,
        lastSyncAt: channel.lastSyncAt?.toISOString() ?? null,
        lastError: channel.lastError,
      })),
    };
  }

  async setMode(owner: AssistantOwner, input: { workspaceId: string; channelId: string; mode: ChannelMode }) {
    await this.#ready();
    if (!(await this.#deps.storage.getConnection(owner))) {
      throw new AssistantError('not_connected', 'Connect ClickUp first.', 409);
    }
    const channel = await this.#deps.storage.setMode(owner, input.workspaceId, input.channelId, input.mode, this.#now());
    if (!channel) throw new AssistantError('not_found', 'Channel not found.', 404);
    return channel;
  }

  /** Reads the channel list again now and polls; the settings' «Sync now». */
  async syncNow(owner: AssistantOwner): Promise<PollResult> {
    await this.#ready();
    const connection = await this.#deps.storage.getConnection(owner);
    if (!connection) throw new AssistantError('not_connected', 'Connect ClickUp first.', 409);
    await this.#deps.storage.patchConnection(owner, { channelsListedAt: null }, this.#now());
    return this.poll(owner);
  }

  // Reading

  /** Connections due a poll now. */
  async due(limit: number): Promise<AssistantOwner[]> {
    await this.#ready();
    return (await this.#deps.storage.dueConnections(this.#now(), limit)).map(connection => connection.owner);
  }

  /** One poll of the person's ClickUp; one at a time per person. */
  async poll(owner: AssistantOwner): Promise<PollResult> {
    const key = `${owner.orgId}\u0000${owner.userId}`;
    const running = this.#polling.get(key);
    if (running) return running;
    const run = this.#poll(owner).finally(() => this.#polling.delete(key));
    this.#polling.set(key, run);
    return run;
  }

  async #poll(owner: AssistantOwner): Promise<PollResult> {
    await this.#ready();
    const { storage } = this.#deps;
    const connection = await storage.getConnection(owner);
    const result: PollResult = { ingested: 0, channels: 0, calls: 0 };
    if (!connection || connection.status !== 'active') return result;
    const started = this.#now();
    let client: ClickUpChatClient | undefined;
    try {
      const access = await this.#token(owner, connection);
      if (!access) {
        // The organization's connection went (or is no longer this person's): stop, and say so.
        await storage.patchConnection(owner, { status: 'rejected', lastError: ORG_CONNECTION_GONE, nextPollAt: null }, this.#now());
        result.error = ORG_CONNECTION_GONE;
        return result;
      }
      client = this.#client(access.token, this.limits.callsPerPoll);
      const listedAt = connection.channelsListedAt?.getTime() ?? 0;
      if (started.getTime() - listedAt >= this.limits.channelsRefreshMs) await this.#listChannels(owner, client);
      const members = await this.#members(client);
      const channels = (await storage.listChannels(owner))
        .filter(channel => channel.mode !== 'ignore' && !channel.gone)
        .sort((a, b) => (a.lastSyncAt?.getTime() ?? 0) - (b.lastSyncAt?.getTime() ?? 0))
        .slice(0, this.limits.channelsPerPoll);
      for (const channel of channels) {
        if (client.remaining <= 0) break;
        // Disconnected or erased meanwhile: stop at once, write nothing more.
        if (!(await storage.getConnection(owner))) return result;
        try {
          result.ingested += await this.#readChannel(owner, connection, client, channel, members);
          result.channels += 1;
          await storage.patchChannel(owner, channel.workspaceId, channel.channelId, { lastSyncAt: this.#now(), lastError: null }, this.#now());
        } catch (error) {
          if (error instanceof ClickUpBudgetSpent) break;
          if (error instanceof ClickUpChatError && (error.status === 401 || error.status === 429)) throw error;
          await storage.patchChannel(
            owner,
            channel.workspaceId,
            channel.channelId,
            { lastSyncAt: this.#now(), lastError: errorText(error) },
            this.#now(),
          );
        }
      }
      await storage.pruneThreads(owner, started.getTime() - this.limits.followThreadsMs);
      result.calls = client.calls;
      if (await storage.getConnection(owner)) {
        await storage.patchConnection(
          owner,
          {
            lastSyncAt: this.#now(),
            lastError: null,
            failures: 0,
            nextPollAt: new Date(this.#now().getTime() + this.limits.intervalMs),
          },
          this.#now(),
        );
      }
      return result;
    } catch (error) {
      result.calls = client?.calls ?? 0;
      result.error = errorText(error);
      if (!(await storage.getConnection(owner))) return result;
      if (error instanceof ClickUpChatError && error.rejected) {
        // The token was revoked or is wrong: stop until the person connects again.
        await storage.patchConnection(owner, { status: 'rejected', lastError: 'ClickUp no longer accepts this token. Connect again.', nextPollAt: null }, this.#now());
        return result;
      }
      const failures = connection.failures + 1;
      const backoff = Math.min(this.limits.intervalMs * 2 ** failures, this.limits.maxBackoffMs);
      const retryAt = error instanceof ClickUpChatError && error.retryAt ? error.retryAt.getTime() : 0;
      await storage.patchConnection(
        owner,
        { lastError: result.error, failures, nextPollAt: new Date(Math.max(this.#now().getTime() + backoff, retryAt)) },
        this.#now(),
      );
      // Loud, without content: who and why.
      console.error(`[assistant] ClickUp poll of ${owner.orgId}/${owner.userId} failed (${failures} in a row):`, result.error);
      return result;
    }
  }

  async #listChannels(owner: AssistantOwner, client: ClickUpChatClient): Promise<void> {
    const listed: Array<{ workspaceId: string; channelId: string; name: string; kind: ChannelKind; defaultMode: ChannelMode }> = [];
    const workspaces = await client.workspaces();
    for (const workspace of workspaces) {
      let cursor: string | null = null;
      for (let page = 0; page < 10; page += 1) {
        const result = await client.channels(workspace.id, { cursor });
        for (const channel of result.items) {
          if (channel.archived) continue;
          const kind = kindOf(channel);
          listed.push({
            workspaceId: workspace.id,
            channelId: channel.id,
            name: channel.name || (kind === 'channel' ? channel.id : 'DM'),
            kind,
            defaultMode: defaultMode(kind),
          });
        }
        cursor = result.nextCursor;
        if (!cursor) break;
      }
    }
    await this.#deps.storage.syncChannels(owner, listed, this.#now());
    await this.#deps.storage.patchConnection(owner, { channelsListedAt: this.#now() }, this.#now());
  }

  /** Member names by user id across the person's workspaces (one call). */
  async #members(client: ClickUpChatClient): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    for (const workspace of await client.workspaces()) for (const [id, name] of workspace.members) names.set(id, name);
    return names;
  }

  /**
   * Reads one channel since its cursor: new top-level messages (newest first, back to the cursor),
   * and new replies of the threads on those pages whose reply count grew. A channel read for the
   * first time after being turned on only sets its cursor: history is never read.
   */
  async #readChannel(
    owner: AssistantOwner,
    connection: SourceConnection,
    client: ClickUpChatClient,
    channel: SourceChannel,
    members: Map<string, string>,
  ): Promise<number> {
    const { storage } = this.#deps;
    const { workspaceId, channelId } = channel;
    const roots: ChatMessage[] = [];
    let cursor: string | null = null;
    let reachedCursor = false;
    for (let page = 0; page < this.limits.pagesPerChannel; page += 1) {
      const result = await client.messages(workspaceId, channelId, { cursor, limit: 50 });
      roots.push(...result.items);
      cursor = result.nextCursor;
      if (channel.cursorAt === null) break;
      if (!cursor || result.items.some(message => message.date <= channel.cursorAt!)) {
        reachedCursor = true;
        break;
      }
    }

    if (channel.cursorAt === null) {
      // First read: remember where the channel stands; nothing before now becomes a request.
      const newest = roots.length ? roots.reduce((max, message) => Math.max(max, message.date), 0) : this.#now().getTime();
      for (const root of roots) {
        await storage.putThread(owner, {
          workspaceId,
          channelId,
          messageId: root.id,
          rootAt: root.date,
          repliesCount: root.repliesCount,
          replyCursorAt: this.#now().getTime(),
          involvesMe: root.userId === connection.accountId,
        });
      }
      await storage.patchChannel(owner, workspaceId, channelId, { cursorAt: newest });
      return 0;
    }
    if (!reachedCursor) {
      // More new messages than the pages allowed: the oldest are skipped, said in the channel's status.
      await storage.patchChannel(owner, workspaceId, channelId, {
        lastError: `More than ${this.limits.pagesPerChannel * 50} new messages since the last read; older ones were skipped.`,
      });
    }

    // What to take in, oldest first: new roots, and new replies of threads whose count grew.
    const incoming: Array<{ message: ChatMessage; rootId: string }> = [];
    let newest = channel.cursorAt;
    for (const root of roots) {
      const isNew = root.date > channel.cursorAt;
      if (isNew) {
        incoming.push({ message: root, rootId: root.id });
        newest = Math.max(newest, root.date);
      }
      const known = await storage.getThread(owner, workspaceId, root.id);
      const thread = known ?? {
        workspaceId,
        channelId,
        messageId: root.id,
        rootAt: root.date,
        // A thread first seen on an old root: its replies so far are history, only new ones count.
        repliesCount: isNew ? 0 : root.repliesCount,
        replyCursorAt: isNew ? 0 : this.#now().getTime(),
        involvesMe: root.userId === connection.accountId,
      };
      if (root.repliesCount > thread.repliesCount) {
        const replies = await this.#newReplies(client, workspaceId, channelId, root.id, thread.replyCursorAt);
        for (const reply of replies) incoming.push({ message: reply, rootId: root.id });
        thread.replyCursorAt = replies.reduce((max, reply) => Math.max(max, reply.date), thread.replyCursorAt);
      }
      thread.repliesCount = Math.max(thread.repliesCount, root.repliesCount);
      if (!known || known.repliesCount !== thread.repliesCount || known.replyCursorAt !== thread.replyCursorAt) {
        await storage.putThread(owner, thread);
      }
    }
    incoming.sort((a, b) => a.message.date - b.message.date);

    let ingested = 0;
    for (const { message, rootId } of incoming) {
      if (!(await storage.getConnection(owner))) return ingested;
      const fromMe = message.userId === connection.accountId;
      const thread = await storage.getThread(owner, workspaceId, rootId);
      if (fromMe && thread && !thread.involvesMe) await storage.putThread(owner, { ...thread, involvesMe: true });
      const sourceKey = `clickup:${workspaceId}:${channelId}:${rootId}`;
      const take =
        fromMe ||
        (message.parentMessageId !== null && (await this.#deps.ingest.hasOpenSourceRequest(owner, sourceKey))) ||
        (await this.#wanted(client, channel, message, thread?.involvesMe ?? false, connection.accountId));
      if (!take) continue;
      const outcome = await this.#deps.ingest.ingestSourceMessage(owner, {
        platform: 'clickup',
        sourceKey,
        messageKey: `clickup:${workspaceId}:${message.id}`,
        text: message.content,
        fromName: members.get(message.userId) ?? (message.userId || null),
        sourceUrl: channelUrl(workspaceId, channelId),
        files: await this.#files(client, message.content),
        fromMe,
        analyse: fromMe ? false : this.#turns.allow(owner, this.limits.turnsPerHour, this.#now().getTime()),
        where: channel.kind === 'channel' ? `#${channel.name}` : channel.kind === 'dm' ? `DM ${channel.name}` : `group DM ${channel.name}`,
      });
      if (outcome.outcome !== 'duplicate' && outcome.outcome !== 'skipped') ingested += 1;
    }
    if (newest > channel.cursorAt) await storage.patchChannel(owner, workspaceId, channelId, { cursorAt: newest });
    return ingested;
  }

  /**
   * Whether a message someone else wrote is for the assistant in this channel's mode: `watch` takes
   * everything; `addressed` takes a DM, a reply in a thread the person is in, or a mention of them.
   * (A reply in a thread that already has an open request is taken by the caller either way.)
   */
  async #wanted(
    client: ClickUpChatClient,
    channel: SourceChannel,
    message: ChatMessage,
    threadInvolvesMe: boolean,
    me: string,
  ): Promise<boolean> {
    if (channel.mode === 'watch') return true;
    if (channel.mode !== 'addressed') return false;
    if (channel.kind !== 'channel') return true;
    if (message.parentMessageId && threadInvolvesMe) return true;
    const tagged = await client.taggedUsers(channel.workspaceId, message.id);
    return tagged.includes(me);
  }

  /** Files the message links to on ClickUp's hosts; a file that cannot be fetched is skipped. */
  async #files(client: ClickUpChatClient, content: string): Promise<SourceMessage['files']> {
    const files: SourceMessage['files'] = [];
    for (const link of fileLinks(content).slice(0, 5)) {
      if (client.remaining <= 1) break;
      try {
        const { bytes, mime } = await client.download(link.url, this.#deps.maxFileBytes ?? ASSISTANT_FILE_MAX_BYTES);
        files.push({ name: link.name, declaredMime: mime, bytes });
      } catch (error) {
        if (error instanceof ClickUpBudgetSpent) break;
        console.warn('[assistant] A ClickUp file could not be downloaded:', errorText(error));
      }
    }
    return files;
  }

  /** New replies of a thread (newer than `after`), oldest first. */
  async #newReplies(client: ClickUpChatClient, workspaceId: string, channelId: string, rootId: string, after: number) {
    const out: ChatMessage[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 3; page += 1) {
      const result = await client.replies(workspaceId, channelId, rootId, { cursor, limit: 50 });
      const fresh = result.items.filter(reply => reply.date > after);
      out.push(...fresh);
      cursor = result.nextCursor;
      if (!cursor || fresh.length < result.items.length) break;
    }
    return out.sort((a, b) => a.date - b.date);
  }
}
