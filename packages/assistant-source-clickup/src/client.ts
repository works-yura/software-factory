/**
 * ClickUp Chat, read with the person's own personal API token (ADR-0051 phase 2). What the API
 * offers is recorded in `docs/features/assistant/clickup-chat.md`; in short:
 *
 * - v2 `GET /user` (who the token is) and `GET /team` (workspaces with their members);
 * - v3 `GET /workspaces/{ws}/chat/channels` (channels, DMs and group DMs as one list, by type;
 *   `is_follower=true` for the ones in the person's sidebar), `…/channels/{id}/members` (who is in
 *   a DM: its only names), `…/channels/{id}/messages` and `…/messages/{id}/replies` (newest first, cursor-paged, no
 *   "since" filter), `…/messages/{id}/tagged_users` (mentions);
 * - no chat webhooks, no attachment field on chat messages.
 *
 * Every call counts against a budget the caller gives, so one poll cannot spend the person's
 * ClickUp rate limit (100 requests a minute on most plans).
 */

export const CLICKUP_API_ORIGIN = 'https://api.clickup.com';

export class ClickUpChatError extends Error {
  readonly status: number;
  /** When ClickUp said the rate limit resets (from `X-RateLimit-Reset`), on a 429. */
  readonly retryAt: Date | null;
  constructor(message: string, status: number, retryAt: Date | null = null) {
    super(message);
    this.name = 'ClickUpChatError';
    this.status = status;
    this.retryAt = retryAt;
  }

  /** The token is wrong or was revoked: polling stops until the person connects again. */
  get rejected(): boolean {
    return this.status === 401;
  }
}

/** The poll spent the calls it was given; the rest waits for the next poll. */
export class ClickUpBudgetSpent extends Error {
  constructor() {
    super('The ClickUp call budget of this poll is spent.');
    this.name = 'ClickUpBudgetSpent';
  }
}

export interface ClickUpMe {
  id: string;
  username: string;
  email: string;
}

export interface ClickUpWorkspaceInfo {
  id: string;
  name: string;
  /** Member names by user id, for naming who wrote a message. */
  members: Map<string, string>;
  /** Member profile pictures by user id, where ClickUp has one. */
  avatars: Map<string, string>;
}

/**
 * Where a location channel lives: ClickUp's location type numbers (as its Docs API names them —
 * 4 Space, 5 Folder, 6 List). The chat spec only says `parent.type` is a number; anything else is
 * a plain channel.
 */
export type ChannelLocationKind = 'space' | 'folder' | 'list';

export function locationKindOf(parentType: number | null): ChannelLocationKind | null {
  return parentType === 4 ? 'space' : parentType === 5 ? 'folder' : parentType === 6 ? 'list' : null;
}

/** A person in a channel (`ChatSimpleUser`). */
export interface ChatMember {
  id: string;
  name: string;
}

export type ChatChannelType = 'CHANNEL' | 'DM' | 'GROUP_DM';

export interface ChatChannel {
  id: string;
  name: string;
  type: ChatChannelType;
  workspaceId: string;
  archived: boolean;
  visibility: 'PUBLIC' | 'PRIVATE' | null;
  /** The location (Space, Folder, List) a location channel belongs to; `null` for a plain channel or a DM. */
  location: { kind: ChannelLocationKind; id: string } | null;
  /** The person hid this DM from their sidebar. */
  hidden: boolean;
}

export interface ChatMessage {
  id: string;
  content: string;
  /** Epoch milliseconds. */
  date: number;
  userId: string;
  channelId: string;
  /** The root message, for a reply; `null` for a top-level message. */
  parentMessageId: string | null;
  repliesCount: number;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface ClickUpChatClientOptions {
  token: string;
  origin?: string;
  fetch?: typeof globalThis.fetch;
  /** How many calls this client may make; unlimited when absent. */
  budget?: number;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function millis(value: unknown): number {
  const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
  if (Number.isFinite(n) && n > 0) return n;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

/** A ClickUp personal API token: `pk_` and digits/letters. OAuth tokens are not taken here. */
export function isPersonalToken(token: string): boolean {
  return /^pk_[A-Za-z0-9_]{8,}$/.test(token.trim());
}

function toChannel(raw: unknown, workspaceId: string): ChatChannel | null {
  const row = record(raw);
  const id = str(row.id);
  if (!id) return null;
  const type = str(row.type).toUpperCase();
  return {
    id,
    name: str(row.name),
    type: type === 'DM' || type === 'GROUP_DM' ? type : 'CHANNEL',
    workspaceId: str(row.workspace_id) || workspaceId,
    archived: row.archived === true,
    visibility: row.visibility === 'PUBLIC' || row.visibility === 'PRIVATE' ? row.visibility : null,
    location: locationOf(record(row.parent)),
    hidden: row.is_hidden === true,
  };
}

function locationOf(parent: Record<string, unknown>): ChatChannel['location'] {
  const id = str(parent.id);
  const kind = locationKindOf(typeof parent.type === 'number' ? parent.type : Number(parent.type));
  return id && kind ? { kind, id } : null;
}

function toMessage(raw: unknown, channelId: string): ChatMessage | null {
  const row = record(raw);
  const id = str(row.id);
  if (!id) return null;
  return {
    id,
    content: str(row.content),
    date: millis(row.date),
    userId: str(row.user_id),
    channelId: str(row.parent_channel) || channelId,
    parentMessageId: str(row.parent_message) || null,
    repliesCount: Number(row.replies_count) || 0,
  };
}

export class ClickUpChatClient {
  readonly #token: string;
  readonly #origin: string;
  readonly #fetch: typeof globalThis.fetch;
  #budget: number;
  #calls = 0;

  constructor(options: ClickUpChatClientOptions) {
    this.#token = options.token.trim();
    this.#origin = (options.origin ?? CLICKUP_API_ORIGIN).replace(/\/+$/, '');
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#budget = options.budget ?? Number.POSITIVE_INFINITY;
  }

  /** Calls made so far. */
  get calls(): number {
    return this.#calls;
  }

  /** Calls left in the budget. */
  get remaining(): number {
    return this.#budget - this.#calls;
  }

  /** v2: the account the token belongs to. */
  async me(): Promise<ClickUpMe> {
    const user = record((await this.#get('/api/v2/user')).user);
    const id = str(user.id);
    if (!id) throw new ClickUpChatError('ClickUp did not say whose token this is.', 502);
    return { id, username: str(user.username), email: str(user.email) };
  }

  /** v2: the workspaces ("teams") the token reaches, with their members' names. */
  async workspaces(): Promise<ClickUpWorkspaceInfo[]> {
    const body = await this.#get('/api/v2/team');
    return array(body.teams).flatMap(raw => {
      const team = record(raw);
      const id = str(team.id);
      if (!id) return [];
      const members = new Map<string, string>();
      const avatars = new Map<string, string>();
      for (const member of array(team.members)) {
        const user = record(record(member).user);
        const userId = str(user.id);
        if (!userId) continue;
        members.set(userId, str(user.username) || str(user.email) || userId);
        const picture = str(user.profilePicture);
        if (/^https:\/\//.test(picture)) avatars.set(userId, picture);
      }
      return [{ id, name: str(team.name) || id, members, avatars }];
    });
  }

  /**
   * v3: one page of the channels, DMs and group DMs the person can see; with `following`, only the
   * ones they follow (what their ClickUp sidebar shows).
   */
  async channels(
    workspaceId: string,
    input: { cursor?: string | null; limit?: number; following?: boolean } = {},
  ): Promise<Page<ChatChannel>> {
    const query = new URLSearchParams({ limit: String(input.limit ?? 100), is_follower: input.following ? 'true' : 'false' });
    if (input.cursor) query.set('cursor', input.cursor);
    const body = await this.#get(`/api/v3/workspaces/${encodeURIComponent(workspaceId)}/chat/channels?${query}`);
    return {
      items: array(body.data).flatMap(raw => toChannel(raw, workspaceId) ?? []),
      nextCursor: str(body.next_cursor) || null,
    };
  }

  /** v3: the people in a channel (for a DM, the only way to its names); the first page. */
  async channelMembers(workspaceId: string, channelId: string): Promise<ChatMember[]> {
    const body = await this.#get(
      `/api/v3/workspaces/${encodeURIComponent(workspaceId)}/chat/channels/${encodeURIComponent(channelId)}/members?limit=100`,
    );
    return array(body.data).flatMap(raw => {
      const user = record(raw);
      const id = str(user.id);
      return id ? [{ id, name: str(user.name) || str(user.username) || str(user.email) || id }] : [];
    });
  }

  /**
   * v2: the path of a location (names, outermost first): a List → Space › Folder › List (a
   * folderless list's hidden folder is left out), a Folder → Space › Folder, a Space → Space.
   */
  async locationPath(kind: ChannelLocationKind, id: string): Promise<string[]> {
    const path = `/api/v2/${kind}/${encodeURIComponent(id)}`;
    const body = await this.#get(path);
    const name = str(body.name);
    if (kind === 'space') return [name].filter(Boolean);
    const space = str(record(body.space).name);
    if (kind === 'folder') return [space, name].filter(Boolean);
    const folder = record(body.folder);
    const folderName = folder.hidden === true ? '' : str(folder.name);
    return [space, folderName, name].filter(Boolean);
  }

  /** v3: one page of a channel's top-level messages, newest first. */
  async messages(
    workspaceId: string,
    channelId: string,
    input: { cursor?: string | null; limit?: number } = {},
  ): Promise<Page<ChatMessage>> {
    const query = new URLSearchParams({ limit: String(input.limit ?? 50), content_format: 'text/md' });
    if (input.cursor) query.set('cursor', input.cursor);
    const body = await this.#get(
      `/api/v3/workspaces/${encodeURIComponent(workspaceId)}/chat/channels/${encodeURIComponent(channelId)}/messages?${query}`,
    );
    return {
      items: array(body.data).flatMap(raw => toMessage(raw, channelId) ?? []),
      nextCursor: str(body.next_cursor) || null,
    };
  }

  /** v3: one page of a message's replies, newest first. */
  async replies(
    workspaceId: string,
    channelId: string,
    messageId: string,
    input: { cursor?: string | null; limit?: number } = {},
  ): Promise<Page<ChatMessage>> {
    const query = new URLSearchParams({ limit: String(input.limit ?? 50), content_format: 'text/md' });
    if (input.cursor) query.set('cursor', input.cursor);
    const body = await this.#get(
      `/api/v3/workspaces/${encodeURIComponent(workspaceId)}/chat/messages/${encodeURIComponent(messageId)}/replies?${query}`,
    );
    return {
      items: array(body.data).flatMap(raw => {
        const message = toMessage(raw, channelId);
        return message ? [{ ...message, parentMessageId: message.parentMessageId ?? messageId }] : [];
      }),
      nextCursor: str(body.next_cursor) || null,
    };
  }

  /** v3: the user ids a message mentions. */
  async taggedUsers(workspaceId: string, messageId: string): Promise<string[]> {
    const body = await this.#get(
      `/api/v3/workspaces/${encodeURIComponent(workspaceId)}/chat/messages/${encodeURIComponent(messageId)}/tagged_users?limit=100`,
    );
    return array(body.data).flatMap(raw => {
      const id = str(record(raw).id);
      return id ? [id] : [];
    });
  }

  /**
   * Bytes of a file a message links to. Only ClickUp's own hosts get the token; anything else is
   * refused, so a link in a message can never carry the token elsewhere.
   */
  async download(url: string, maxBytes: number): Promise<{ bytes: Uint8Array; mime: string | null }> {
    if (!isClickUpFileUrl(url)) throw new ClickUpChatError('Refusing to download a file that is not on ClickUp.', 400);
    this.#spend();
    const response = await this.#fetch(url, { headers: { Authorization: this.#token } });
    if (!response.ok) throw new ClickUpChatError(`ClickUp file download failed with ${response.status}.`, response.status);
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) throw new ClickUpChatError('The file is larger than the limit.', 413);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new ClickUpChatError('The file is larger than the limit.', 413);
    return { bytes, mime: response.headers.get('content-type') };
  }

  #spend(): void {
    if (this.#calls >= this.#budget) throw new ClickUpBudgetSpent();
    this.#calls += 1;
  }

  async #get(path: string): Promise<Record<string, unknown>> {
    this.#spend();
    const response = await this.#fetch(`${this.#origin}${path}`, {
      headers: { Authorization: this.#token, Accept: 'application/json' },
    });
    if (!response.ok) {
      const reset = Number(response.headers.get('x-ratelimit-reset'));
      const retryAt = response.status === 429 && Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000) : null;
      // ClickUp's error body names the problem (`{ err, ECODE }` in v2, `{ message }` in v3); never the token.
      let detail = '';
      try {
        const body = record(await response.json());
        detail = str(body.err) || str(body.message);
      } catch {
        // No JSON body.
      }
      throw new ClickUpChatError(
        `ClickUp answered ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}.`,
        response.status,
        retryAt,
      );
    }
    return record(await response.json());
  }
}

/** ClickUp's file hosts (attachments are served from `*.clickup-attachments.com` and `*.clickup.com`). */
export function isClickUpFileUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  return (
    host === 'clickup-attachments.com' ||
    host.endsWith('.clickup-attachments.com') ||
    host === 'attachments.clickup.com' ||
    host.endsWith('.clickup.com')
  );
}

/**
 * File links in a message's Markdown that point at ClickUp's file hosts (`![name](url)` or
 * `[name](url)`). The chat API has no attachment field, so this is the only trace a pasted
 * screenshot leaves in the message the API returns.
 */
export function fileLinks(markdown: string): Array<{ name: string; url: string }> {
  const out: Array<{ name: string; url: string }> = [];
  const seen = new Set<string>();
  for (const match of markdown.matchAll(/!?\[([^\]]*)\]\((https:\/\/[^)\s]+)\)/g)) {
    const url = match[2]!;
    if (!isClickUpFileUrl(url) || seen.has(url)) continue;
    // A link to a page (task, doc, chat) is not a file: only paths that look like a file name.
    const last = new URL(url).pathname.split('/').pop() ?? '';
    if (!/\.[A-Za-z0-9]{2,5}$/.test(last)) continue;
    seen.add(url);
    out.push({ name: match[1]?.trim() || decodeURIComponent(last), url });
  }
  return out;
}

/** A link to the channel at ClickUp (`app.clickup.com/{ws}/chat/r/{channel}`). */
export function channelUrl(workspaceId: string, channelId: string): string {
  return `https://app.clickup.com/${encodeURIComponent(workspaceId)}/chat/r/${encodeURIComponent(channelId)}`;
}
