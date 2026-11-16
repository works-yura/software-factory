/**
 * ClickUp Chat as a personal source of «Помічник» (ADR-0051 phase 2): the person connects their
 * own personal API token; the assistant lists the channels and DMs it sees, reads the ones the
 * person turned on (a mode per channel), and turns threads into requests through the core's
 * `ingestSourceMessage` (binding key `clickup:<workspace>:<channel>:<root message>`, idempotent by
 * message id). It never writes to ClickUp.
 */
import { AssistantError, ASSISTANT_FILE_MAX_BYTES, formatChannelRule } from '@factory/assistant-core';
import type {
  AssistantOwner,
  AssistantSource,
  ChannelMode,
  ChannelRule,
  SecretCipher,
  SourceChannelInfo,
  SourceChannelMessages,
  SourceDownload,
  SourceMessage,
} from '@factory/assistant-core';

import type {
  ChannelLocationKind,
  ChatChannel,
  ChatMessage,
  ClickUpCallTrace,
  ClickUpChatClientOptions,
  ClickUpWorkspaceInfo,
} from './client.ts';
import { channelUrl, ClickUpBudgetSpent, ClickUpChatClient, ClickUpChatError, isClickUpFileUrl, isPersonalToken } from './client.ts';
import type { MessageAttachment } from './client.ts';
import type { OrgClickUpReader } from './org-connection.ts';
import { orgConnectionFor } from './org-connection.ts';
import type { ChannelKind, ChannelMember, ClickUpSourceStorage, DetailsWhat, SourceChannel, SourceConnection } from './storage.ts';
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
  /** ClickUp calls one on-demand read by the agent's tool may make. */
  callsPerRead: number;
  /**
   * Channels described per poll: a DM's people (`…/members`), a channel's followers (is the person
   * one: their sidebar) and a location channel's path. Rows never described, or whose lookup failed
   * a while ago, go first.
   */
  detailsPerListing: number;
  /** A failed lookup is tried again after this long (a good one after a day). */
  detailsRetryMs: number;
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
  callsPerRead: 3,
  detailsPerListing: 15,
  detailsRetryMs: 10 * MINUTE,
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
   * Whether a channel rule can run (a rule that asks a Factory needs one the person reaches): the
   * core's `checkChannelRule`. Throws an `AssistantError` saying why not.
   */
  checkRule?: (owner: AssistantOwner, rule: ChannelRule) => Promise<void>;
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

/**
 * How a channel is called in the list: a DM or group DM by its other people (the API gives DMs no
 * name), a channel by its own name.
 */
export function channelDisplayName(channel: Pick<SourceChannel, 'kind' | 'name' | 'members'>): string {
  if (channel.kind !== 'channel') {
    const names = (channel.members ?? []).map(member => member.name).filter(Boolean);
    if (names.length) return names.join(', ');
    return channel.name || (channel.kind === 'dm' ? 'Direct message' : 'Group message');
  }
  return channel.name;
}

/**
 * In the person's ClickUp sidebar: a channel they follow — by the `is_follower=true` filter of the
 * listing, or found among the channel's `…/followers` — and a DM they did not hide.
 */
export function inSidebarOf(channel: Pick<SourceChannel, 'kind' | 'following' | 'follower' | 'hidden'>): boolean {
  return channel.kind === 'channel' ? channel.following || channel.follower === true : !channel.hidden;
}

function ownerKey(owner: AssistantOwner): string {
  return `${owner.orgId}\u0000${owner.userId}`;
}

/** Member names by user id across the person's workspaces (from v2 `/team`). */
function namesOf(workspaces: ClickUpWorkspaceInfo[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const workspace of workspaces) for (const [id, name] of workspace.members) names.set(id, name);
  return names;
}

function kindOf(channel: ChatChannel): ChannelKind {
  return channel.type === 'DM' ? 'dm' : channel.type === 'GROUP_DM' ? 'group_dm' : 'channel';
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The code a failed lookup shows: the HTTP status or the network cause, never a message. */
function errorCode(error: unknown): string {
  if (error instanceof ClickUpChatError) return error.shortCode;
  return (error instanceof Error ? error.name : 'error').slice(0, 40);
}

/** Calls kept per read for the diagnostics. */
const DIAGNOSTIC_CALLS = 300;

/**
 * The last ClickUp read of one person, redacted to its shape (`GET …/clickup/diagnostics`): per
 * call the endpoint (no ids), status, counts, keys and enum values; no names, no message text, no
 * token.
 */
export interface ClickUpDiagnostics {
  /** When the read started. */
  at: string;
  trigger: 'connect' | 'poll' | 'read';
  calls: ClickUpCallTrace[];
  /** Calls left out past the first `DIAGNOSTIC_CALLS`. */
  droppedCalls: number;
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
    /** In the person's ClickUp sidebar: a channel they follow, a DM they did not hide. The rest is behind «show all». */
    inSidebar: boolean;
    visibility: 'PUBLIC' | 'PRIVATE' | null;
    /** A location channel's Space/Folder/List and its path (outermost first; empty until looked up). */
    location: { kind: ChannelLocationKind; path: string[] } | null;
    /** A DM's or group DM's other people (empty until looked up). */
    members: ChannelMember[];
    /** Why the last lookup of its people / path / followers failed (`code`: HTTP status, network cause, `empty`). */
    detailsError: { what: DetailsWhat; code: string } | null;
    mode: ChannelMode;
    /** `analyse`, `analyse_and_ask:<factoryId>` or `digest_only`. */
    rule: string;
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
  /** The last read of each person, as shapes only (in memory: diagnostics, not history). */
  readonly #diagnostics = new Map<string, ClickUpDiagnostics>();

  constructor(deps: ClickUpSourceDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? (() => new Date());
    this.limits = { ...DEFAULT_POLL_LIMITS, ...deps.limits };
  }

  /**
   * A client for one read. Every call it makes is logged as one structured line and kept as the
   * person's last read for the diagnostics — shapes only: endpoint, status, counts, keys, enums.
   */
  #client(owner: AssistantOwner, trigger: ClickUpDiagnostics['trigger'], token: string, budget?: number): ClickUpChatClient {
    const record: ClickUpDiagnostics = { at: this.#now().toISOString(), trigger, calls: [], droppedCalls: 0 };
    this.#diagnostics.set(ownerKey(owner), record);
    const observe = (trace: ClickUpCallTrace) => {
      if (record.calls.length < DIAGNOSTIC_CALLS) record.calls.push(trace);
      else record.droppedCalls += 1;
      // Logged: the list, members/followers, location and workspace calls, and every failure; the
      // message reads only into the diagnostics (they would flood the log every poll).
      if (trace.status !== 200 || !/^v3\.chat\.(messages|replies|tagged_users)$|^file$/.test(trace.endpoint)) {
        console.info(`[assistant] clickup.call ${JSON.stringify({ org: owner.orgId, user: owner.userId, trigger, ...trace })}`);
      }
    };
    const options: ClickUpChatClientOptions = { token, observe, ...(budget !== undefined ? { budget } : {}) };
    return this.#deps.client ? this.#deps.client(options) : new ClickUpChatClient(options);
  }

  /**
   * The person's last ClickUp read and what the stored channel list adds up to, without content:
   * counts by kind, how many are in the sidebar (by the `is_follower` filter, by `…/followers`),
   * how many DMs have their people, and the lookup failures by code.
   */
  async diagnostics(owner: AssistantOwner) {
    await this.#ready();
    const connection = await this.#deps.storage.getConnection(owner);
    if (!connection) throw new AssistantError('not_connected', 'Connect ClickUp first.', 409);
    const channels = (await this.#deps.storage.listChannels(owner)).filter(channel => !channel.gone);
    const count = (test: (channel: SourceChannel) => boolean) => channels.filter(test).length;
    const failures: Record<string, number> = {};
    for (const channel of channels) {
      if (!channel.detailsError) continue;
      const key = `${channel.detailsError.what}:${channel.detailsError.code}`;
      failures[key] = (failures[key] ?? 0) + 1;
    }
    const dms = (channel: SourceChannel) => channel.kind !== 'channel';
    return {
      connection: {
        status: connection.status,
        lastSyncAt: connection.lastSyncAt?.toISOString() ?? null,
        failures: connection.failures,
        channelsListedAt: connection.channelsListedAt?.toISOString() ?? null,
        nextPollAt: connection.nextPollAt?.toISOString() ?? null,
        hasError: connection.lastError !== null,
      },
      channels: {
        total: channels.length,
        byKind: { channel: count(c => c.kind === 'channel'), dm: count(c => c.kind === 'dm'), group_dm: count(c => c.kind === 'group_dm') },
        listedWithSidebarFacts: count(c => c.factsKnown),
        followingByFilter: count(c => c.kind === 'channel' && c.following),
        followerByEndpoint: count(c => c.kind === 'channel' && c.follower === true),
        followersLookedUp: count(c => c.kind === 'channel' && c.follower !== null),
        inSidebar: count(c => inSidebarOf(c)),
        hiddenDms: count(c => dms(c) && c.hidden),
        dmsWithPeople: count(c => dms(c) && (c.members?.length ?? 0) > 0),
        dmsWithoutPeople: count(c => dms(c) && (c.members?.length ?? 0) === 0),
        dmsWithUnnamedPeople: count(c => dms(c) && (c.members ?? []).some(member => !member.name || member.name === member.id)),
        locationChannels: count(c => c.location !== null),
        locationsWithPath: count(c => (c.location?.path?.length ?? 0) > 0),
        neverDescribed: count(c => c.detailsAt === null),
        lookupFailures: failures,
      },
      lastRead: this.#diagnostics.get(ownerKey(owner)) ?? null,
    };
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
    const client = this.#client(owner, 'connect', token);
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
      await this.#listChannels(owner, this.#client(owner, 'connect', token));
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
    // DMs first (they are what reaches the person), then channels, each by the name the list shows.
    const order: Record<ChannelKind, number> = { dm: 0, group_dm: 1, channel: 2 };
    const channels = (await this.#deps.storage.listChannels(owner))
      .filter(channel => !channel.gone)
      .map(channel => ({ channel, displayName: channelDisplayName(channel) }))
      .sort(
        (a, b) =>
          order[a.channel.kind] - order[b.channel.kind] ||
          a.displayName.localeCompare(b.displayName) ||
          (a.channel.location?.path ?? []).join('/').localeCompare((b.channel.location?.path ?? []).join('/')),
      );
    return {
      connected: true,
      via,
      orgOffer: via === 'org' ? null : orgOffer,
      account: { id: connection.accountId, name: connection.accountName },
      status: connection.status,
      lastSyncAt: connection.lastSyncAt?.toISOString() ?? null,
      lastError: connection.lastError,
      nextPollAt: connection.nextPollAt?.toISOString() ?? null,
      channels: channels.map(({ channel, displayName }) => ({
        workspaceId: channel.workspaceId,
        channelId: channel.channelId,
        name: displayName,
        kind: channel.kind,
        // In the person's ClickUp sidebar: a channel they follow, a DM they did not hide.
        inSidebar: inSidebarOf(channel),
        visibility: channel.visibility,
        location: channel.location ? { kind: channel.location.kind, path: channel.location.path ?? [] } : null,
        members: channel.members ?? [],
        detailsError: channel.detailsError,
        mode: channel.mode,
        rule: formatChannelRule(channel.rule),
        lastSyncAt: channel.lastSyncAt?.toISOString() ?? null,
        lastError: channel.lastError,
      })),
    };
  }

  async setMode(owner: AssistantOwner, input: { workspaceId: string; channelId: string; mode: ChannelMode }) {
    return this.setChannel(owner, input);
  }

  /**
   * Sets a channel's mode and/or its rule for new requests. A rule that asks a Factory on its own
   * is checked first (the Factory must be one the person reaches) and is only ever set here, by the
   * person: it is never a default.
   */
  async setChannel(owner: AssistantOwner, input: { workspaceId: string; channelId: string; mode?: ChannelMode; rule?: ChannelRule }) {
    await this.#ready();
    if (!(await this.#deps.storage.getConnection(owner))) {
      throw new AssistantError('not_connected', 'Connect ClickUp first.', 409);
    }
    if (input.rule?.kind === 'analyse_and_ask') {
      if (!this.#deps.checkRule) throw new AssistantError('rule_unavailable', 'Asking a Factory from a channel rule is not available here.', 409);
      await this.#deps.checkRule(owner, input.rule);
    }
    const channel = await this.#deps.storage.setChannel(
      owner,
      input.workspaceId,
      input.channelId,
      { ...(input.mode !== undefined ? { mode: input.mode } : {}), ...(input.rule !== undefined ? { rule: input.rule } : {}) },
      this.#now(),
    );
    if (!channel) throw new AssistantError('not_found', 'Channel not found.', 404);
    return channel;
  }

  // On demand, for the agent's tools

  /** The chats the person turned on (any mode but `ignore`), for the agent. */
  async enabledChannels(owner: AssistantOwner): Promise<SourceChannelInfo[]> {
    await this.#ready();
    if (!(await this.#deps.storage.getConnection(owner))) return [];
    return (await this.#deps.storage.listChannels(owner))
      .filter(channel => channel.mode !== 'ignore' && !channel.gone)
      .map(channel => this.#info(channel));
  }

  /**
   * The latest messages of a chat the person turned on — or of one thread in it — read now with the
   * person's connection (own token, or the organization's while provably theirs), within `callsPerRead` ClickUp calls. A chat that is off, gone or unknown
   * is refused: the agent reads only what the person chose to let the assistant read.
   */
  async readChannel(owner: AssistantOwner, input: { ref: string; threadId?: string; limit?: number }): Promise<SourceChannelMessages> {
    await this.#ready();
    const match = /^clickup:([^:]+):([^:]+)$/.exec(input.ref);
    const refused = () => new AssistantError('not_found', 'No such chat among the ones you turned on.', 404);
    if (!match) throw refused();
    const channel = await this.#deps.storage.getChannel(owner, match[1]!, match[2]!);
    if (!channel || channel.mode === 'ignore' || channel.gone) throw refused();
    const connection = await this.#deps.storage.getConnection(owner);
    if (!connection || connection.status !== 'active') throw new AssistantError('not_connected', 'ClickUp is not connected (or no longer accepts the token).', 409);
    // The person's own token, or the organization's while it is still provably theirs — as polling.
    const access = await this.#token(owner, connection);
    if (!access) throw new AssistantError('not_connected', ORG_CONNECTION_GONE, 409);
    const client = this.#client(owner, 'read', access.token, this.limits.callsPerRead);
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 30);
    try {
      const members = namesOf(await client.workspaces());
      const page = input.threadId
        ? await client.replies(channel.workspaceId, channel.channelId, input.threadId, { limit })
        : await client.messages(channel.workspaceId, channel.channelId, { limit });
      const names = await this.#authorNames(client, channel, members, page.items.map(message => message.userId));
      return {
        channel: this.#info(channel),
        messages: page.items
          .sort((a, b) => a.date - b.date)
          .map(message => ({
            id: message.id,
            from: names.get(message.userId) ?? null,
            text: message.content,
            at: new Date(message.date).toISOString(),
            replies: message.repliesCount,
            threadId: message.parentMessageId,
            ...(message.attachments.length ? { attachments: message.attachments.map(file => ({ name: file.name, url: file.url })) } : {}),
          })),
      };
    } catch (error) {
      if (error instanceof AssistantError) throw error;
      throw new AssistantError('clickup_failed', `ClickUp answered: ${errorText(error)}`, 502);
    }
  }

  /**
   * A file on ClickUp's hosts for the agent's download tool, fetched with the person's connection
   * (their token, or the organization's while provably theirs); `null` for any other host.
   */
  async download(owner: AssistantOwner, url: string, maxBytes: number): Promise<SourceDownload | null> {
    if (!isClickUpFileUrl(url)) return null;
    await this.#ready();
    const connection = await this.#deps.storage.getConnection(owner);
    if (!connection || connection.status !== 'active') throw new AssistantError('not_connected', 'ClickUp is not connected (or no longer accepts the token).', 409);
    const access = await this.#token(owner, connection);
    if (!access) throw new AssistantError('not_connected', ORG_CONNECTION_GONE, 409);
    const client = this.#client(owner, 'read', access.token, 1);
    try {
      return await client.download(url, maxBytes);
    } catch (error) {
      if (error instanceof ClickUpChatError && error.status === 413) throw new AssistantError('file_too_large', 'The file is larger than the limit.', 413);
      throw new AssistantError('clickup_failed', `ClickUp answered: ${errorText(error)}`, 502);
    }
  }

  #info(channel: SourceChannel): SourceChannelInfo {
    return {
      ref: `clickup:${channel.workspaceId}:${channel.channelId}`,
      name: channelDisplayName(channel),
      kind: channel.kind,
      mode: channel.mode,
      rule: channel.rule,
    };
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
      client = this.#client(owner, 'poll', access.token, this.limits.callsPerPoll);
      const listedAt = connection.channelsListedAt?.getTime() ?? 0;
      const workspaces = await client.workspaces();
      // Rows listed before the sidebar facts were kept (`following` never stored) are listed again now.
      const unlisted = (await storage.listChannels(owner)).some(channel => !channel.gone && !channel.factsKnown);
      if (unlisted || started.getTime() - listedAt >= this.limits.channelsRefreshMs) {
        await this.#listChannels(owner, client, workspaces);
      } else {
        // What a listing could not describe (budget, a failure) is looked up on the next polls.
        await this.#lookUpDetails(owner, client, workspaces);
      }
      const members = namesOf(workspaces);
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
      // Loud, without content: who and why (a network error names its cause code).
      console.error(`[assistant] ClickUp poll of ${owner.orgId}/${owner.userId} failed (${failures} in a row):`, result.error);
      return result;
    }
  }

  /**
   * Reads the channel list: every channel the token sees, which of them the person follows (their
   * ClickUp sidebar, `is_follower=true`), then — within `detailsPerListing` calls — what the list
   * does not name: a DM's people (`…/members`) and a location channel's Space › Folder › List.
   * What is looked up is kept and looked up again after a day.
   */
  async #listChannels(owner: AssistantOwner, client: ClickUpChatClient, known?: ClickUpWorkspaceInfo[]): Promise<void> {
    const listed: Parameters<ClickUpSourceStorage['syncChannels']>[1] = [];
    const workspaces = known ?? (await client.workspaces());
    for (const workspace of workspaces) {
      const following = new Set<string>();
      let cursor: string | null = null;
      for (let page = 0; page < 10; page += 1) {
        const result = await client.channels(workspace.id, { cursor, following: true });
        for (const channel of result.items) following.add(channel.id);
        cursor = result.nextCursor;
        if (!cursor) break;
      }
      cursor = null;
      for (let page = 0; page < 10; page += 1) {
        const result = await client.channels(workspace.id, { cursor });
        for (const channel of result.items) {
          if (channel.archived) continue;
          const kind = kindOf(channel);
          listed.push({
            workspaceId: workspace.id,
            channelId: channel.id,
            name: channel.name || (kind === 'channel' ? channel.id : ''),
            kind,
            defaultMode: defaultMode(kind),
            following: following.has(channel.id),
            hidden: channel.hidden,
            visibility: channel.visibility,
            location: kind === 'channel' ? channel.location : null,
          });
        }
        cursor = result.nextCursor;
        if (!cursor) break;
      }
    }
    await this.#deps.storage.syncChannels(owner, listed, this.#now());
    await this.#deps.storage.patchConnection(owner, { channelsListedAt: this.#now() }, this.#now());
    await this.#lookUpDetails(owner, client, workspaces);
  }

  /**
   * What the channel list does not give, a bounded number of channels per poll: a DM's people
   * (`…/members`, named from the workspace members when ClickUp sends them bare), whether the person
   * follows a channel (`…/followers`) and a location channel's Space › Folder › List. A lookup that
   * fails keeps its code on the row (the settings show it) and is tried again after `detailsRetryMs`.
   */
  async #lookUpDetails(owner: AssistantOwner, client: ClickUpChatClient, workspaces: ClickUpWorkspaceInfo[]): Promise<void> {
    const { storage } = this.#deps;
    const connection = await storage.getConnection(owner);
    if (!connection) return;
    const now = this.#now().getTime();
    const due = (channel: SourceChannel) =>
      !channel.detailsAt ||
      channel.detailsAt.getTime() < now - DAY ||
      (channel.detailsError !== null && channel.detailsAt.getTime() <= now - this.limits.detailsRetryMs);
    const wanted = (await storage.listChannels(owner)).filter(channel => !channel.gone && due(channel));
    // Never described first, then the person's sidebar: those are the rows they look for.
    wanted.sort(
      (a, b) =>
        Number(a.detailsAt !== null) - Number(b.detailsAt !== null) ||
        Number(inSidebarOf(b)) - Number(inSidebarOf(a)),
    );
    const names = namesOf(workspaces);
    const avatars = new Map<string, string>(workspaces.flatMap(workspace => [...workspace.avatars]));
    const paths = new Map<string, string[]>();
    let spent = 0;
    for (const channel of wanted) {
      if (spent >= this.limits.detailsPerListing || client.remaining <= 1) break;
      spent += 1;
      const found: Parameters<ClickUpSourceStorage['setDetails']>[3] = {};
      let error: { what: DetailsWhat; code: string } | null = null;
      const attempt = async (what: DetailsWhat, run: () => Promise<void>) => {
        try {
          await run();
        } catch (failure) {
          if (failure instanceof ClickUpBudgetSpent) throw failure;
          if (failure instanceof ClickUpChatError && (failure.status === 401 || failure.status === 429)) throw failure;
          error ??= { what, code: errorCode(failure) };
          console.warn(`[assistant] clickup.details ${JSON.stringify({ org: owner.orgId, user: owner.userId, what, kind: channel.kind, code: errorCode(failure) })}`);
        }
      };
      try {
        if (channel.kind !== 'channel') {
          await attempt('members', async () => {
            const people = await client.channelMembers(channel.workspaceId, channel.channelId);
            const others = people.filter(member => member.id !== connection.accountId);
            const members = others.map(member => ({
              id: member.id,
              name: member.name || names.get(member.id) || member.email || member.id,
              avatarUrl: avatars.get(member.id) ?? null,
            }));
            found.members = members;
            if (!people.length) error ??= { what: 'members', code: 'empty' };
            // Only the person themself came back: the DM has nobody to be named after.
            else if (!others.length) error ??= { what: 'members', code: 'only-self' };
            else if (members.some(member => member.name === member.id)) error ??= { what: 'members', code: 'unnamed' };
          });
        } else {
          await attempt('followers', async () => {
            const followers = await client.channelFollowers(channel.workspaceId, channel.channelId);
            found.follower = followers.some(member => member.id === connection.accountId);
          });
          const location = channel.location;
          if (location) {
            await attempt('path', async () => {
              const key = `${location.kind}:${location.id}`;
              const path = paths.get(key) ?? (await client.locationPath(location.kind, location.id));
              paths.set(key, path);
              found.path = path;
              if (!path.length) error ??= { what: 'path', code: 'empty' };
            });
          }
        }
      } catch (failure) {
        // Out of calls halfway: nothing is stored, the channel is described whole on the next poll.
        if (failure instanceof ClickUpBudgetSpent) break;
        throw failure;
      }
      await storage.setDetails(owner, channel.workspaceId, channel.channelId, { ...found, error }, this.#now());
    }
  }

  /** Bulk: one mode for every DM and group DM (e.g. all of them «only when addressed»). */
  async setDmModes(owner: AssistantOwner, mode: ChannelMode): Promise<number> {
    await this.#ready();
    if (!(await this.#deps.storage.getConnection(owner))) throw new AssistantError('not_connected', 'Connect ClickUp first.', 409);
    let changed = 0;
    for (const channel of await this.#deps.storage.listChannels(owner)) {
      if (channel.gone || channel.kind === 'channel' || channel.mode === mode) continue;
      await this.#deps.storage.setChannel(owner, channel.workspaceId, channel.channelId, { mode }, this.#now());
      changed += 1;
    }
    return changed;
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

    const names = await this.#authorNames(client, channel, members, incoming.map(({ message }) => message.userId));
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
        fromName: names.get(message.userId) ?? null,
        sourceUrl: channelUrl(workspaceId, channelId),
        files: await this.#files(client, message.attachments),
        fromMe,
        // A digest-only channel never spends a turn; the others count against the hourly limit.
        analyse: fromMe || channel.rule.kind === 'digest_only' ? false : this.#turns.allow(owner, this.limits.turnsPerHour, this.#now().getTime()),
        rule: channel.rule,
        where:
          channel.kind === 'channel'
            ? `#${[...(channel.location?.path?.slice(0, -1) ?? []), channel.name].join(' › ')}`
            : channel.kind === 'dm'
              ? `DM ${channelDisplayName(channel)}`
              : `group DM ${channelDisplayName(channel)}`,
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

  /**
   * Who wrote what: workspace members first (v2 `/team`), then the channel's own people (stored
   * from its listing, else read once now, within the budget) — guests and people of a shared DM
   * are not workspace members. Someone still unknown has no name (never a raw id).
   */
  async #authorNames(client: ClickUpChatClient, channel: SourceChannel, members: Map<string, string>, userIds: string[]): Promise<Map<string, string>> {
    const names = new Map(members);
    for (const person of channel.members ?? []) if (person.name && !names.has(person.id)) names.set(person.id, person.name);
    const unknown = [...new Set(userIds)].filter(id => id && !names.has(id));
    if (unknown.length === 0 || client.remaining <= 1) return names;
    try {
      for (const person of await client.channelMembers(channel.workspaceId, channel.channelId, 1)) {
        const name = person.name || person.email;
        if (name && !names.has(person.id)) names.set(person.id, name);
      }
    } catch (error) {
      if (!(error instanceof ClickUpBudgetSpent)) console.warn('[assistant] ClickUp channel members could not be read for author names:', errorText(error));
    }
    return names;
  }

  /** The files a message carries, fetched now; a file that cannot be fetched is skipped (and logged). */
  async #files(client: ClickUpChatClient, attachments: MessageAttachment[]): Promise<SourceMessage['files']> {
    const files: SourceMessage['files'] = [];
    for (const link of attachments.slice(0, 5)) {
      if (client.remaining <= 1) break;
      try {
        const { bytes, mime } = await client.download(link.url, this.#deps.maxFileBytes ?? ASSISTANT_FILE_MAX_BYTES);
        files.push({ name: link.name, declaredMime: mime ?? link.mime, bytes });
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
