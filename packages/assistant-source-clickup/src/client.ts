/**
 * ClickUp Chat, read with the person's own personal API token (ADR-0051 phase 2). What the API
 * offers is recorded in `docs/features/assistant/clickup-chat.md`; in short:
 *
 * - v2 `GET /user` (who the token is) and `GET /team` (workspaces with their members);
 * - v3 `GET /workspaces/{ws}/chat/channels` (channels, DMs and group DMs as one list, by `type`;
 *   `is_follower=true` is a *filter* — "only return Channels the user is following" — not a field of
 *   the channel, and ClickUp silently ignores query parameters it does not know, so the filter is
 *   sent only when wanted), `…/channels/{id}/members` and `…/channels/{id}/followers`
 *   (`ChatSimpleUser` `{ id, email, name?, username?, initials? }`, cursor-paged — a DM's only
 *   names), `…/channels/{id}/messages` and `…/messages/{id}/replies` (newest first, cursor-paged),
 *   `…/messages/{id}/tagged_users` (mentions);
 * - a DM's `name` is not a person's name (live data shows the literal "DM"): its people come from
 *   `…/members`, named from the workspace members of v2 `/team` when a member comes back bare;
 * - no chat webhooks, no attachment field on chat messages.
 *
 * Every call counts against a budget the caller gives, so one poll cannot spend the person's
 * ClickUp rate limit (100 requests a minute on most plans).
 */

export const CLICKUP_API_ORIGIN = 'https://api.clickup.com';

export class ClickUpChatError extends Error {
  /** The HTTP status; `0` when ClickUp was not reached at all (a network error). */
  readonly status: number;
  /** When ClickUp said the rate limit resets (from `X-RateLimit-Reset`), on a 429. */
  readonly retryAt: Date | null;
  /** The network error's cause (`err.cause.code`, e.g. `ECONNRESET`), for status 0; ClickUp's `ECODE` otherwise. */
  readonly code: string | null;
  constructor(message: string, status: number, retryAt: Date | null = null, code: string | null = null) {
    super(message);
    this.name = 'ClickUpChatError';
    this.status = status;
    this.retryAt = retryAt;
    this.code = code;
  }

  /** What the settings show as the code: the HTTP status, or the network cause. */
  get shortCode(): string {
    return this.status === 0 ? (this.code ?? 'network') : String(this.status);
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

/** A person in a channel (`ChatSimpleUser`); `name` is empty when ClickUp gave none. */
export interface ChatMember {
  id: string;
  name: string;
  email?: string;
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
  /** Files the message carries: ClickUp file links in its Markdown and any attachment field the API returns. */
  attachments: MessageAttachment[];
}

/** A file a message carries, on ClickUp's hosts (fetched with the person's token only). */
export interface MessageAttachment {
  name: string;
  url: string;
  mime: string | null;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/**
 * One ClickUp call as diagnostics see it: the shape of the answer, never its content — no names, no
 * message text, no ids in the path, never the token. Logged and kept for
 * `GET /web/assistant/sources/clickup/diagnostics`.
 */
export interface ClickUpCallTrace {
  /** What was asked, e.g. `v3.chat.channels`, `v3.chat.channels?is_follower`, `v3.chat.members`, `v2.list`. */
  endpoint: string;
  /** HTTP status; `0` when ClickUp was not reached. */
  status: number;
  /** Tries (a network error or a 5xx is tried again with backoff). */
  attempts: number;
  ms: number;
  /** The network error's cause code when ClickUp was not reached; ClickUp's `ECODE` on an error answer. */
  errorCode?: string;
  /** Items in the answer's list (`data`, `teams`). */
  count?: number;
  /** Whether the answer gave a cursor for a next page. */
  nextCursor?: boolean;
  /** The answer's top-level keys. */
  keys?: string[];
  /** Every key seen on the list's items (first 100). */
  itemKeys?: string[];
  /** What the list's items are (`object`, `string`, `number`): a members list of bare ids shows here. */
  itemKinds?: string[];
  /** Values of enum-like fields only (`type`, `visibility`, `parent.type`, `is_hidden` …) and URL templates of `links.*`. */
  enums?: Record<string, string[]>;
}

export interface ClickUpChatClientOptions {
  token: string;
  origin?: string;
  fetch?: typeof globalThis.fetch;
  /** How many calls this client may make; unlimited when absent. */
  budget?: number;
  /** Told about every call (its shape, never its content). */
  observe?: (trace: ClickUpCallTrace) => void;
  /** Tries after the first one on a network error or a 5xx (default 2), with doubling backoff. */
  retries?: number;
  /** The first backoff (default 500 ms). */
  retryDelayMs?: number;
  /** Waits between tries; tests give an instant one. */
  sleep?: (ms: number) => Promise<void>;
}

/** Fields whose values are enums (or booleans), safe to show in diagnostics. No other field's value is ever kept. */
const ENUM_FIELDS = [
  'type',
  'visibility',
  'archived',
  'is_hidden',
  'is_canonical_channel',
  'channel_type',
  'chat_room_category',
  'parent.type',
  'default_view.type',
  'folder.hidden',
  'resolved',
] as const;

/** A link with its ids taken out: `https://api.clickup.com/api/v3/workspaces/{id}/chat/channels/{id}/members`. */
export function urlTemplate(value: string): string {
  let url: URL;
  try {
    url = new URL(value, 'https://api.clickup.com');
  } catch {
    return '(not a url)';
  }
  const segments = url.pathname.split('/');
  const path = segments
    .map((segment, index) => {
      if (/^v\d$/.test(segment)) return segment;
      const before = segments[index - 1] ?? '';
      const named = /^(workspaces|channels|messages|team|space|folder|list|task|user)$/.test(before);
      return named || /\d/.test(segment) || segment.length > 24 ? '{id}' : segment;
    })
    .join('/');
  return `${/^https?:/i.test(value) ? `${url.protocol}//${url.host}` : ''}${path}`;
}

function pathValue(row: Record<string, unknown>, path: string): unknown {
  let value: unknown = row;
  for (const key of path.split('.')) value = record(value)[key];
  return value;
}

export type ClickUpShape = Omit<ClickUpCallTrace, 'endpoint' | 'status' | 'attempts' | 'ms' | 'errorCode'>;

/** The shape of an answer: keys, counts, enum values — never a name, a text or an id. */
export function shapeOf(body: Record<string, unknown>): ClickUpShape {
  const listKey = Array.isArray(body.data) ? 'data' : Array.isArray(body.teams) ? 'teams' : null;
  const out: ClickUpShape = { keys: Object.keys(body).sort() };
  if ('next_cursor' in body) out.nextCursor = Boolean(str(body.next_cursor));
  const enums = new Map<string, Set<string>>();
  const add = (field: string, value: unknown) => {
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return;
    const text = String(value);
    if (text.length > 120) return;
    const set = enums.get(field) ?? new Set<string>();
    if (set.size < 12) set.add(text);
    enums.set(field, set);
  };
  const scan = (row: Record<string, unknown>) => {
    for (const field of ENUM_FIELDS) add(field, pathValue(row, field));
    for (const [name, link] of Object.entries(record(row.links))) if (typeof link === 'string') add(`links.${name}`, urlTemplate(link));
  };
  if (listKey) {
    const list = body[listKey] as unknown[];
    out.count = list.length;
    const itemKeys = new Set<string>();
    const kinds = new Set<string>();
    for (const item of list.slice(0, 100)) {
      kinds.add(item === null ? 'null' : Array.isArray(item) ? 'array' : typeof item);
      const row = record(item);
      for (const key of Object.keys(row)) itemKeys.add(key);
      scan(row);
      // v2 /team: what a workspace member looks like (keys of `members[].user` only) and how many.
      if (listKey === 'teams') {
        const members = array(row.members);
        for (const member of members) for (const key of Object.keys(record(record(member).user))) itemKeys.add(`members[].user.${key}`);
        add('members.count', members.length);
      }
    }
    out.itemKeys = [...itemKeys].sort();
    out.itemKinds = [...kinds].sort();
  } else {
    scan(body);
  }
  if (enums.size) out.enums = Object.fromEntries([...enums].sort(([a], [b]) => a.localeCompare(b)).map(([key, set]) => [key, [...set].sort()]));
  return out;
}

/** The cause of a `fetch failed`: Node's undici puts the system code on `err.cause.code`. */
export function networkCause(error: unknown): string {
  const cause = record(record(error).cause);
  return (str(cause.code) || str(cause.name) || (error instanceof Error ? error.name : '') || 'unknown').slice(0, 40);
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

/**
 * A channel member as `…/members` / `…/followers` return it: documented as a flat `ChatSimpleUser`
 * (`id`, `email` required; `name`, `username` optional). Also taken: a bare id, and `{ user: {…} }`
 * as v2 nests users — so a different live shape shows up as members, not as an empty list.
 */
export function toMember(raw: unknown): ChatMember | null {
  if (typeof raw === 'string' || typeof raw === 'number') {
    const id = str(raw);
    return id ? { id, name: '' } : null;
  }
  const row = record(raw);
  const user = row.user && typeof row.user === 'object' ? record(row.user) : row;
  const id = str(user.id) || str(row.user_id) || str(row.id);
  if (!id) return null;
  const email = str(user.email);
  return { id, name: str(user.name) || str(user.username), ...(email ? { email } : {}) };
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
    attachments: messageAttachments(row),
  };
}

/** The keys an attachment list may come under. The chat spec names none; v2 tasks use `attachments`. */
const ATTACHMENT_KEYS = ['attachments', 'files', 'attachment'] as const;

/**
 * What a message carries: links to ClickUp's file hosts in its Markdown, and the entries of any
 * attachment field (`attachments`, `files`) shaped like v2's task attachments (`url` or `url_w_host`
 * or `download_url`; `title` / `name` / `file_name`; `mimetype`). Only ClickUp file URLs are kept,
 * each once; the token never leaves ClickUp's hosts.
 */
export function messageAttachments(row: Record<string, unknown>): MessageAttachment[] {
  const out: MessageAttachment[] = [];
  const seen = new Set<string>();
  const add = (url: string, name: string, mime: string | null) => {
    if (!url || seen.has(url) || !isClickUpFileUrl(url)) return;
    seen.add(url);
    out.push({ name: name || nameOfUrl(url), url, mime });
  };
  for (const key of ATTACHMENT_KEYS) {
    const value = row[key];
    for (const raw of Array.isArray(value) ? value : value && typeof value === 'object' ? [value] : []) {
      const item = record(raw);
      const url = str(item.url_w_host) || str(item.download_url) || str(item.url);
      const name = str(item.title) || str(item.name) || str(item.file_name) || str(item.filename);
      add(url, name, str(item.mimetype) || str(item.mime_type) || str(item.content_type) || null);
    }
  }
  for (const link of fileLinks(str(row.content))) add(link.url, link.name, null);
  return out;
}

function nameOfUrl(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '') || 'file';
  } catch {
    return 'file';
  }
}

export class ClickUpChatClient {
  readonly #token: string;
  readonly #origin: string;
  readonly #fetch: typeof globalThis.fetch;
  #budget: number;
  #calls = 0;
  readonly #observe: ((trace: ClickUpCallTrace) => void) | undefined;
  readonly #retries: number;
  readonly #retryDelayMs: number;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(options: ClickUpChatClientOptions) {
    this.#token = options.token.trim();
    this.#origin = (options.origin ?? CLICKUP_API_ORIGIN).replace(/\/+$/, '');
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#budget = options.budget ?? Number.POSITIVE_INFINITY;
    this.#observe = options.observe;
    this.#retries = Math.max(0, options.retries ?? 2);
    this.#retryDelayMs = options.retryDelayMs ?? 500;
    this.#sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
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
    const user = record((await this.#get('/api/v2/user', 'v2.user')).user);
    const id = str(user.id);
    if (!id) throw new ClickUpChatError('ClickUp did not say whose token this is.', 502);
    return { id, username: str(user.username), email: str(user.email) };
  }

  /** v2: the workspaces ("teams") the token reaches, with their members' names. */
  async workspaces(): Promise<ClickUpWorkspaceInfo[]> {
    const body = await this.#get('/api/v2/team', 'v2.team');
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
        // A member without a username or e-mail stays unnamed: a raw id is never shown as a name.
        const name = str(user.username) || str(user.email);
        if (name) members.set(userId, name);
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
    // `is_follower` is a filter (default false = every channel); sent only to ask for the followed ones.
    const query = new URLSearchParams({ limit: String(input.limit ?? 100) });
    if (input.following) query.set('is_follower', 'true');
    if (input.cursor) query.set('cursor', input.cursor);
    const body = await this.#get(
      `/api/v3/workspaces/${encodeURIComponent(workspaceId)}/chat/channels?${query}`,
      input.following ? 'v3.chat.channels?is_follower' : 'v3.chat.channels',
    );
    return {
      items: array(body.data).flatMap(raw => toChannel(raw, workspaceId) ?? []),
      nextCursor: str(body.next_cursor) || null,
    };
  }

  /**
   * v3: the people in a channel (for a DM, the only way to its names), up to `pages` pages. A member
   * may come back without a name (only `id` and `email` are required): `name` is then empty and the
   * caller names them from the workspace members.
   */
  async channelMembers(workspaceId: string, channelId: string, pages = 3): Promise<ChatMember[]> {
    return this.#people(workspaceId, channelId, 'members', pages);
  }

  /** v3: who follows a channel (`…/followers`): the person among them means it is in their sidebar. */
  async channelFollowers(workspaceId: string, channelId: string, pages = 3): Promise<ChatMember[]> {
    return this.#people(workspaceId, channelId, 'followers', pages);
  }

  async #people(workspaceId: string, channelId: string, what: 'members' | 'followers', pages: number): Promise<ChatMember[]> {
    const out: ChatMember[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < pages; page += 1) {
      const query = new URLSearchParams({ limit: '100' });
      if (cursor) query.set('cursor', cursor);
      const body = await this.#get(
        `/api/v3/workspaces/${encodeURIComponent(workspaceId)}/chat/channels/${encodeURIComponent(channelId)}/${what}?${query}`,
        `v3.chat.${what}`,
      );
      for (const raw of array(body.data)) {
        const member = toMember(raw);
        if (member && !out.some(known => known.id === member.id)) out.push(member);
      }
      cursor = str(body.next_cursor) || null;
      if (!cursor) break;
    }
    return out;
  }

  /**
   * v2: the path of a location (names, outermost first): a List → Space › Folder › List (a
   * folderless list's hidden folder is left out), a Folder → Space › Folder, a Space → Space.
   */
  async locationPath(kind: ChannelLocationKind, id: string): Promise<string[]> {
    const path = `/api/v2/${kind}/${encodeURIComponent(id)}`;
    const body = await this.#get(path, `v2.${kind}`);
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
      'v3.chat.messages',
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
      'v3.chat.replies',
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
      'v3.chat.tagged_users',
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
    const started = Date.now();
    const { response, attempts } = await this.#send(url, { Authorization: this.#token }, 'file', started);
    this.#observe?.({ endpoint: 'file', status: response.status, attempts, ms: Date.now() - started });
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

  /**
   * One request, tried again on a network error (`fetch failed`) or a 5xx with doubling backoff. A
   * network error that outlasts the tries becomes a `ClickUpChatError` with status 0 and the
   * cause's code, so the settings say what went wrong instead of «fetch failed».
   */
  async #send(
    url: string,
    headers: Record<string, string>,
    endpoint: string,
    started: number,
  ): Promise<{ response: Response; attempts: number }> {
    for (let attempt = 1; ; attempt += 1) {
      let response: Response;
      try {
        response = await this.#fetch(url, { headers });
      } catch (error) {
        if (attempt <= this.#retries) {
          await this.#sleep(this.#retryDelayMs * 2 ** (attempt - 1));
          continue;
        }
        const code = networkCause(error);
        this.#observe?.({ endpoint, status: 0, attempts: attempt, ms: Date.now() - started, errorCode: code });
        throw new ClickUpChatError(`ClickUp could not be reached (${code}) after ${attempt} tries.`, 0, null, code);
      }
      if (response.status >= 500 && attempt <= this.#retries) {
        await response.body?.cancel().catch(() => undefined);
        await this.#sleep(this.#retryDelayMs * 2 ** (attempt - 1));
        continue;
      }
      return { response, attempts: attempt };
    }
  }

  async #get(path: string, endpoint: string): Promise<Record<string, unknown>> {
    this.#spend();
    const started = Date.now();
    const { response, attempts } = await this.#send(
      `${this.#origin}${path}`,
      { Authorization: this.#token, Accept: 'application/json' },
      endpoint,
      started,
    );
    if (!response.ok) {
      const reset = Number(response.headers.get('x-ratelimit-reset'));
      const retryAt = response.status === 429 && Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000) : null;
      // ClickUp's error body names the problem (`{ err, ECODE }` in v2, `{ message }` in v3); never the token.
      let detail = '';
      let ecode = '';
      try {
        const body = record(await response.json());
        detail = str(body.err) || str(body.message);
        ecode = str(body.ECODE).slice(0, 40);
      } catch {
        // No JSON body.
      }
      this.#observe?.({ endpoint, status: response.status, attempts, ms: Date.now() - started, ...(ecode ? { errorCode: ecode } : {}) });
      throw new ClickUpChatError(
        `ClickUp answered ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}.`,
        response.status,
        retryAt,
        ecode || null,
      );
    }
    const body = record(await response.json());
    this.#observe?.({ endpoint, status: response.status, attempts, ms: Date.now() - started, ...shapeOf(body) });
    return body;
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
