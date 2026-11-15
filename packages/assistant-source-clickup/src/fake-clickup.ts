/**
 * A fake ClickUp for tests: answers the v2/v3 calls the source makes, in the response shapes the
 * official reference documents (developer.clickup.com, `ClickUp_PUBLIC_API_V3.yaml`): pagination
 * envelope `{ data, next_cursor }`, channels with `type` CHANNEL/DM/GROUP_DM, messages newest first
 * with epoch-ms `date`, `user_id`, `parent_channel`, `parent_message`, `replies_count`. No real token
 * and no network: it is a `fetch`.
 */

export interface FakeMessage {
  id: string;
  channel: string;
  user: string;
  content: string;
  date: number;
  parent?: string;
  tagged?: string[];
}

export class FakeClickUp {
  readonly token = 'pk_12345678_FAKEFAKEFAKEFAKE';
  me = { id: 42, username: 'ada', email: 'ada@example.com' };
  workspaces = [
    {
      id: '9001',
      name: 'Acme',
      members: [
        { user: { id: 42, username: 'ada', email: 'ada@example.com' } },
        { user: { id: 7, username: 'Olena', email: 'olena@example.com' } },
        { user: { id: 8, username: 'Taras', email: 'taras@example.com' } },
      ],
    },
  ];
  channels = [
    { id: 'ch-general', name: 'general', type: 'CHANNEL' },
    { id: 'ch-support', name: 'support', type: 'CHANNEL' },
    { id: 'dm-olena', name: 'Olena', type: 'DM' },
  ];
  messages: FakeMessage[] = [];
  files = new Map<string, Uint8Array>();
  /** Every request path, in order. */
  readonly calls: string[] = [];
  /** Answer every call with this status instead (401, 429 …). */
  failWith: { status: number; reset?: number } | null = null;
  pageSize = 50;

  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    this.calls.push(`${url.hostname === 'api.clickup.com' ? '' : url.hostname}${url.pathname}${url.search}`);
    const auth = new Headers(init?.headers).get('authorization');
    if (this.failWith) {
      return new Response(JSON.stringify({ err: 'failed', ECODE: 'X' }), {
        status: this.failWith.status,
        headers: this.failWith.reset ? { 'x-ratelimit-reset': String(this.failWith.reset) } : {},
      });
    }
    if (auth !== this.token) return Response.json({ err: 'Token invalid', ECODE: 'OAUTH_025' }, { status: 401 });
    if (url.hostname !== 'api.clickup.com') {
      const bytes = this.files.get(url.href);
      return bytes ? new Response(bytes, { headers: { 'content-type': 'image/png' } }) : new Response('nope', { status: 404 });
    }
    const path = url.pathname;
    if (path === '/api/v2/user') return Response.json({ user: this.me });
    if (path === '/api/v2/team') return Response.json({ teams: this.workspaces });
    let match = /^\/api\/v3\/workspaces\/([^/]+)\/chat\/channels$/.exec(path);
    if (match) {
      return Response.json({
        next_cursor: '',
        data: this.channels.map(channel => ({
          ...channel,
          visibility: 'PUBLIC',
          parent: { id: match![1], type: 7 },
          creator: '7',
          created_at: '1700000000000',
          updated_at: '1700000000000',
          workspace_id: match![1],
          archived: false,
          links: { members: '', followers: '' },
        })),
      });
    }
    match = /^\/api\/v3\/workspaces\/[^/]+\/chat\/channels\/([^/]+)\/messages$/.exec(path);
    if (match) {
      const roots = this.messages.filter(message => message.channel === match![1] && !message.parent);
      return this.#page(roots, url);
    }
    match = /^\/api\/v3\/workspaces\/[^/]+\/chat\/messages\/([^/]+)\/replies$/.exec(path);
    if (match) return this.#page(this.messages.filter(message => message.parent === match![1]), url);
    match = /^\/api\/v3\/workspaces\/[^/]+\/chat\/messages\/([^/]+)\/tagged_users$/.exec(path);
    if (match) {
      const message = this.messages.find(candidate => candidate.id === match![1]);
      return Response.json({
        next_cursor: '',
        data: (message?.tagged ?? []).map(id => ({ id, email: '', name: '', username: '', initials: '' })),
      });
    }
    return Response.json({ status: 404, message: 'Not found' }, { status: 404 });
  };

  /** Newest first, cursor = offset. */
  #page(all: FakeMessage[], url: URL) {
    const sorted = [...all].sort((a, b) => b.date - a.date);
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 50), this.pageSize);
    const offset = Number(url.searchParams.get('cursor') ?? 0);
    const slice = sorted.slice(offset, offset + limit);
    return Response.json({
      next_cursor: offset + limit < sorted.length ? String(offset + limit) : '',
      data: slice.map(message => ({
        id: message.id,
        type: 'message',
        content: message.content,
        date: message.date,
        user_id: message.user,
        parent_channel: message.channel,
        ...(message.parent ? { parent_message: message.parent } : {}),
        resolved: false,
        replies_count: this.messages.filter(reply => reply.parent === message.id).length,
        links: { reactions: '', replies: '', tagged_users: '' },
      })),
    });
  }

  post(message: FakeMessage) {
    this.messages.push(message);
  }
}
