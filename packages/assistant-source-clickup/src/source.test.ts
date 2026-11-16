import { AssistantService, AssistantStorage } from '@factory/assistant-core';
import type { AssistantOwner } from '@factory/assistant-core';
import { FakeBrain, FakeFactory, FakeMemory, fakeModels, MemoryBlobStore, testCipher } from '@factory/assistant-core/testing';
import { LibSQLFactoryStorage } from '@mastra/libsql';
import { beforeEach, describe, expect, it } from 'vitest';

import { ClickUpChatClient, fileLinks, isClickUpFileUrl, messageAttachments, shapeOf, toMember, urlTemplate } from './client.ts';
import { FakeClickUp } from './fake-clickup.ts';
import { startClickUpPolling } from './scheduler.ts';
import type { ClickUpPollLimits } from './source.ts';
import type { OrgClickUpConnection, OrgClickUpReader } from './org-connection.ts';
import { channelDisplayName, ClickUpChatSource, inSidebarOf, ORG_CONNECTION_GONE, sinceLastTag } from './source.ts';
import type { ChannelKind, SourceChannel } from './storage.ts';
import { ClickUpSourceStorage, RETIRED_MODE, SOURCE_CHANNELS, SOURCE_CONNECTIONS, SOURCE_THREADS } from './storage.ts';
import { DEFAULT_TAG_PATTERN, tagMatcher, tagPatternProblem } from './tag.ts';

const ADA: AssistantOwner = { orgId: 'org-a', userId: 'ada' };
const ADA_ELSEWHERE: AssistantOwner = { orgId: 'org-b', userId: 'ada' };
const BOB: AssistantOwner = { orgId: 'org-a', userId: 'bob' };
const WS = '9001';
const T0 = Date.parse('2026-11-15T10:00:00Z');
/** The person's ClickUp user (FakeClickUp.me): the default «who may tag». */
const ME = '42';

let clickup: FakeClickUp;
let core: AssistantStorage;
let storage: ClickUpSourceStorage;
let backend: LibSQLFactoryStorage;
let brain: FakeBrain;
let blobs: MemoryBlobStore;
let pending: Array<Promise<void>>;
let now: number;
let service: AssistantService;
let source: ClickUpChatSource;
let factory: FakeFactory;
/** Backoff waits the clients asked for (instant in tests). */
let sleeps: number[] = [];

function build(limits: Partial<ClickUpPollLimits> = {}, orgClickUp?: OrgClickUpReader) {
  source = new ClickUpChatSource({
    ...(orgClickUp ? { orgClickUp } : {}),
    storage,
    cipher: testCipher,
    ingest: { ingestSourceMessage: (o, m) => service.ingestSourceMessage(o, m) },
    client: options => new ClickUpChatClient({ ...options, fetch: clickup.fetch, sleep: async ms => void sleeps.push(ms) }),
    limits,
    now: () => new Date(now),
  });
  factory = new FakeFactory();
  service = new AssistantService({
    storage: core,
    blobs,
    brain,
    memory: new FakeMemory(),
    models: fakeModels,
    factory,
    grant: factory,
    sources: [source],
    audit: async () => undefined,
    blobReferencedElsewhere: async () => false,
    now: () => new Date(now),
    schedule: task => {
      pending.push(task());
    },
    // The answer is checked by hand here; the background checks are the core's tests.
    limits: { answerPollTimeoutMs: 0 },
  });
}

async function settle() {
  while (pending.length) await pending.shift();
}

async function poll(owner = ADA) {
  const result = await source.poll(owner);
  await settle();
  return result;
}

beforeEach(async () => {
  clickup = new FakeClickUp();
  backend = new LibSQLFactoryStorage({ id: 'clickup-source-test', url: ':memory:' });
  core = backend.registerDomain(new AssistantStorage());
  storage = backend.registerDomain(new ClickUpSourceStorage());
  await backend.init();
  brain = new FakeBrain();
  brain.answer = turn => `report on: ${turn.input.text}`;
  brain.topic = turn => `Topic of ${turn.input.fromName}`;
  blobs = new MemoryBlobStore();
  pending = [];
  now = T0;
  build();
});

/** Connects and lets the first read of every chat set its cursor: from here on, only new messages are looked at. */
async function connectAndArm(owner = ADA) {
  await source.connect(owner, clickup.token);
  now += 1000;
  await poll(owner);
}

/** Posts a message `seconds` after T0 (after the cursor once armed). */
function say(id: string, channel: string, user: string, content: string, seconds: number, extra: { parent?: string } = {}) {
  clickup.post({ id, channel, user, content, date: T0 + seconds * 1000, ...extra });
}

async function next(owner = ADA) {
  now += 60_000;
  return poll(owner);
}

/** The source messages of a request's thread: who and what. */
async function sourceLines(requestId: string, owner = ADA): Promise<Array<[string | null, string]>> {
  return (await core.listMessages(owner, requestId))
    .filter(message => message.author === 'source')
    .map(message => [message.fromName, message.text] as [string | null, string]);
}

/** The first source message of a request: who and what. */
async function firstLine(requestId: string, owner = ADA): Promise<[string | null, string]> {
  const [line] = await sourceLines(requestId, owner);
  if (!line) throw new Error('The request has no source message.');
  return line;
}

/** The stored chats as the settings once listed them: DMs first, then channels, by the name shown. */
async function chatList(owner = ADA) {
  const order: Record<ChannelKind, number> = { dm: 0, group_dm: 1, channel: 2 };
  return (await storage.listChannels(owner))
    .filter(channel => !channel.gone)
    .map(channel => ({
      channelId: channel.channelId,
      name: channelDisplayName(channel),
      kind: channel.kind,
      location: channel.location ? `${channel.location.kind}:${(channel.location.path ?? []).join(' › ')}` : null,
      inSidebar: inSidebarOf(channel),
      members: channel.members ?? [],
      detailsError: channel.detailsError,
    }))
    .sort(
      (a, b) => order[a.kind] - order[b.kind] || a.name.localeCompare(b.name) || (a.location ?? '').localeCompare(b.location ?? ''),
    );
}

describe('connecting a personal token', () => {
  it('refuses what is not a personal token, and a token ClickUp does not accept', async () => {
    await expect(source.connect(ADA, 'Bearer abc')).rejects.toMatchObject({ code: 'invalid_token' });
    await expect(source.connect(ADA, 'pk_00000000_WRONG')).rejects.toMatchObject({ code: 'token_rejected' });
    expect((await source.view(ADA)).connected).toBe(false);
  });

  it('stores the token encrypted, never shows it, lists every chat, and starts with the default tag', async () => {
    const view = await source.connect(ADA, clickup.token);
    expect(view.account).toEqual({ id: '42', name: 'ada' });
    expect(JSON.stringify(view)).not.toContain(clickup.token);
    const stored = await storage.getConnection(ADA);
    expect(stored?.secret.startsWith('enc:')).toBe(true);
    expect(stored?.secret).not.toContain(clickup.token);
    expect(view.tag).toEqual({ pattern: null, defaultPattern: DEFAULT_TAG_PATTERN, who: 'me', contextMessages: 10 });
    expect(view.chats).toEqual({ total: 3, inSidebar: 3 });
    // No per-chat setting comes back: there is none.
    expect(JSON.stringify(view)).not.toMatch(/"mode"|"rule"|"channels"/);
  });

  it('marks chats gone when the list is read again', async () => {
    await source.connect(ADA, clickup.token);
    clickup.channels = clickup.channels.filter(channel => channel.id !== 'ch-support');
    await source.syncNow(ADA);
    expect((await chatList()).map(chat => chat.name)).toEqual(['Olena', 'general']);
    expect((await source.view(ADA)).chats.total).toBe(2);
  });
});

describe('the organization’s ClickUp connection', () => {
  /** Settings › Підключення › ClickUp: the org token (ClickUp user 42, «ada»), saved by someone, and ADR-0018 links. */
  let org: OrgClickUpConnection | null;
  let links: Array<{ clickUpUserId: string; userId: string }>;

  beforeEach(() => {
    org = { token: clickup.token, savedBy: 'ada', account: { id: '42', name: 'ada', workspaces: ['eclipt.ai'] } };
    links = [];
    build({}, {
      connection: async orgId => (orgId === 'org-a' ? org : null),
      linkedUsers: async (orgId, clickUpUserId) =>
        orgId === 'org-a' ? links.filter(link => link.clickUpUserId === clickUpUserId).map(link => link.userId) : [],
    });
  });

  it('is offered to the person who saved its token, and to nobody else in the organization', async () => {
    expect((await source.view(ADA)).orgOffer).toEqual({ accountName: 'ada', workspaces: ['eclipt.ai'] });
    expect((await source.view(BOB)).orgOffer).toBeNull();
    expect((await source.view(ADA_ELSEWHERE)).orgOffer).toBeNull();
    await expect(source.connectOrg(BOB)).rejects.toMatchObject({ code: 'org_connection_not_yours', status: 403 });
    expect((await source.view(BOB)).connected).toBe(false);
  });

  it('follows an identity link (connect FCT-…) over who saved it: an admin pasting someone’s token gets nothing', async () => {
    org = { ...org!, savedBy: 'bob' };
    expect((await source.view(BOB)).orgOffer).not.toBeNull();
    links = [{ clickUpUserId: '42', userId: 'ada' }];
    expect((await source.view(ADA)).orgOffer).toEqual({ accountName: 'ada', workspaces: ['eclipt.ai'] });
    expect((await source.view(BOB)).orgOffer).toBeNull();
    // Two Factory people linked to one ClickUp account prove nothing.
    links.push({ clickUpUserId: '42', userId: 'bob' });
    expect((await source.view(ADA)).orgOffer).toBeNull();
  });

  it('reads with the organization’s token without copying it, and stops with a clear notice once the connection is removed', async () => {
    const view = await source.connectOrg(ADA);
    expect(view).toMatchObject({ connected: true, via: 'org', orgOffer: null, account: { id: '42', name: 'ada' } });
    const stored = await storage.getConnection(ADA);
    expect(stored?.secret).not.toContain(clickup.token);
    now += 1000;
    await poll();
    clickup.post({ id: 'm1', channel: 'ch-general', user: ME, content: '#помічник Checkout fails', date: now + 5000 });
    now += 60_000;
    await poll();
    expect(await core.listRequests(ADA)).toHaveLength(1);

    org = null;
    now += 60_000;
    const result = await poll();
    expect(result.error).toBe(ORG_CONNECTION_GONE);
    expect(await source.view(ADA)).toMatchObject({ status: 'rejected', lastError: ORG_CONNECTION_GONE, via: 'org', nextPollAt: null });
    // Stopped: no longer due a poll.
    expect(await source.due(10)).toEqual([]);
  });

  it('stops too when the token is replaced by someone else’s account', async () => {
    await source.connectOrg(ADA);
    org = { ...org!, savedBy: 'bob', account: { id: '77', name: 'bob', workspaces: [] } };
    now += 60_000;
    await poll();
    expect(await source.view(ADA)).toMatchObject({ status: 'rejected', lastError: ORG_CONNECTION_GONE });
  });

  it('the tag and the agent’s on-demand read work on the organization’s connection too', async () => {
    await source.connectOrg(ADA);
    now += 1000;
    await poll();
    await source.setTag(ADA, { who: 'anyone' });
    clickup.post({ id: 'm1', channel: 'ch-support', user: '7', content: 'is checkout fixed? #помічник', date: T0 + 5000 });
    now += 60_000;
    await poll();
    expect((await core.listRequests(ADA)).map(request => request.fromName)).toEqual(['Olena']);
    const read = await source.readChannel(ADA, { ref: `clickup:${WS}:ch-support` });
    expect(read.messages).toMatchObject([{ id: 'm1', from: 'Olena' }]);
    org = null;
    await expect(source.readChannel(ADA, { ref: `clickup:${WS}:ch-support` })).rejects.toMatchObject({ code: 'not_connected' });
  });

  it('keeps the personal-token path', async () => {
    const view = await source.connect(BOB, clickup.token);
    expect(view).toMatchObject({ connected: true, via: 'personal' });
  });
});

describe('the tag pattern', () => {
  it('the default finds #помічник, @помічник and #assistant in any case, as a whole word, and strips it', () => {
    const tag = tagMatcher(null);
    for (const text of ['#помічник оціни це', 'оціни це @Помічник', '#ПОМІЧНИК', '#assistant look', 'ok @ASSISTANT, check', 'line one\n#помічник']) {
      expect(tag.test(text)).toBe(true);
    }
    for (const text of ['помічник оціни', '#помічникові', '#assistants', 'да', 'ВЖЕ', '7 ЗАПИСАВ', 'email me@assistant.example', '']) {
      expect(tag.test(text)).toBe(false);
    }
    expect(tag.strip('#помічник оціни це')).toBe('оціни це');
    expect(tag.strip('оціни це, @помічник')).toBe('оціни це,');
    expect(tag.strip('#assistant')).toBe('');
  });

  it('a custom pattern must compile, stay short, need a tag, and not nest repetition', () => {
    expect(tagPatternProblem('!!ai\\b')).toBeNull();
    expect(tagPatternProblem('')).toMatch(/empty/);
    expect(tagPatternProblem('(')).toMatch(/not a valid/);
    expect(tagPatternProblem('a?')).toMatch(/empty message/);
    expect(tagPatternProblem('.*')).toMatch(/empty message/);
    expect(tagPatternProblem('да')).toMatch(/ordinary message/);
    expect(tagPatternProblem('(a+)+!')).toMatch(/nested repetition/);
    expect(tagPatternProblem('x'.repeat(201))).toMatch(/longer/);
    expect(tagPatternProblem(DEFAULT_TAG_PATTERN)).toBeNull();
    const custom = tagMatcher('!!ai\\b');
    expect(custom.test('!!AI please look')).toBe(true);
    expect(custom.test('#помічник')).toBe(false);
    expect(custom.strip('!!ai please look')).toBe('please look');
  });

  it('the context is what came after the previous tag, at most the count', () => {
    const tagged = (text: string) => text.startsWith('#');
    expect(sinceLastTag(['a', 'b', 'c'], tagged, 10)).toEqual(['a', 'b', 'c']);
    expect(sinceLastTag(['a', 'b', 'c'], tagged, 2)).toEqual(['b', 'c']);
    expect(sinceLastTag(['a', '#x', 'b', 'c'], tagged, 10)).toEqual(['b', 'c']);
    expect(sinceLastTag(['a', 'b', '#x'], tagged, 10)).toEqual([]);
    expect(sinceLastTag(['a', 'b'], tagged, 0)).toEqual([]);
  });
});

describe('requests only from the tag', () => {
  it('ordinary chat traffic — in a DM, a channel, a thread, from anyone — makes no request and is not kept', async () => {
    await connectAndArm();
    // The production case: a DM with a colleague, ordinary replies.
    say('d1', 'dm-olena', '7', 'ти бачила рахунок?', 5);
    say('d2', 'dm-olena', ME, 'да', 6);
    say('d3', 'dm-olena', '7', 'ВЖЕ', 7);
    say('d4', 'dm-olena', ME, '7 ЗАПИСАВ', 8);
    say('g1', 'ch-general', '7', '@ada can you check the invoice', 9);
    say('g2', 'ch-general', '8', 'reply in a thread', 10, { parent: 'g1' });
    await next();
    await next();
    expect(await core.listRequests(ADA)).toEqual([]);
    expect(brain.turns).toEqual([]);
    // Only cursors and ids are kept: no message text anywhere in the source's tables.
    const ops = (storage as unknown as { ops: { findMany: (table: string, where: object) => Promise<unknown[]> } }).ops;
    const stored = JSON.stringify([
      await ops.findMany(SOURCE_CHANNELS, {}),
      await ops.findMany(SOURCE_THREADS, {}),
      await ops.findMany(SOURCE_CONNECTIONS, {}),
    ]);
    for (const text of ['рахунок', 'ВЖЕ', 'ЗАПИСАВ', 'invoice', 'reply in a thread']) expect(stored).not.toContain(text);
  });

  it('my tag in a DM makes one request: the preceding messages with their authors, and my instruction', async () => {
    await connectAndArm();
    say('d1', 'dm-olena', '7', 'Checkout fails for client X', 5);
    say('d2', 'dm-olena', ME, 'since when?', 6);
    say('d3', 'dm-olena', '7', 'since Monday', 7);
    say('d4', 'dm-olena', ME, '#помічник оціни це', 8);
    await next();
    const [request] = await core.listRequests(ADA);
    expect(request).toMatchObject({
      source: 'clickup',
      fromName: 'ada',
      sourceKey: `clickup:${WS}:dm-olena:d4`,
      sourceUrl: `https://app.clickup.com/${WS}/chat/r/dm-olena`,
      status: 'waiting_me',
    });
    const [from, text] = await firstLine(request!.id);
    expect(from).toBe('ada');
    expect(text).toBe(
      [
        '> **Olena** · 2026-11-15 10:00 UTC',
        '> Checkout fails for client X',
        '>',
        '> **ada** · 2026-11-15 10:00 UTC',
        '> since when?',
        '>',
        '> **Olena** · 2026-11-15 10:00 UTC',
        '> since Monday',
        '',
        'оціни це',
      ].join('\n'),
    );
    expect(brain.turns).toHaveLength(1);
    expect(brain.turns[0]).toMatchObject({ first: true, input: { author: 'source', fromName: 'ada' } });
    expect(brain.turns[0]!.input.text).toContain('(DM Olena)');
    // Taken once: the next polls find nothing new.
    await next();
    expect(await core.listRequests(ADA)).toHaveLength(1);
    expect(brain.turns).toHaveLength(1);
  });

  it('only me by default: a colleague’s tag is ignored until the person lets anyone in the chat tag', async () => {
    await connectAndArm();
    say('o1', 'dm-olena', '7', '#помічник глянь', 5);
    await next();
    expect(await core.listRequests(ADA)).toEqual([]);

    expect((await source.setTag(ADA, { who: 'anyone' })).tag.who).toBe('anyone');
    say('o2', 'dm-olena', '7', '#помічник а тепер?', 70);
    await next();
    const requests = await core.listRequests(ADA);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ fromName: 'Olena', sourceKey: `clickup:${WS}:dm-olena:o2` });
    // The earlier tag (by someone allowed now) bounds the context: nothing before it comes along.
    const [, text] = await firstLine(requests[0]!.id);
    expect(text).toBe('а тепер?');
  });

  it('a custom pattern replaces the default; an invalid one is refused and changes nothing', async () => {
    await connectAndArm();
    await expect(source.setTag(ADA, { pattern: '.*' })).rejects.toMatchObject({ code: 'invalid_tag_pattern', status: 400 });
    await expect(source.setTag(ADA, { contextMessages: 99 })).rejects.toMatchObject({ code: 'invalid_tag_context' });
    await expect(source.setTag(ADA, { who: 'everyone' as never })).rejects.toMatchObject({ code: 'invalid_tag_who' });
    expect((await source.view(ADA)).tag.pattern).toBeNull();
    expect((await source.setTag(ADA, { pattern: '!!ai\\b' })).tag.pattern).toBe('!!ai\\b');
    say('c1', 'ch-general', ME, '#помічник old tag', 5);
    say('c2', 'ch-general', ME, '!!AI summarise', 6);
    await next();
    const requests = await core.listRequests(ADA);
    expect(requests.map(request => request.sourceKey)).toEqual([`clickup:${WS}:ch-general:c2`]);
    // Back to the default.
    expect((await source.setTag(ADA, { pattern: null })).tag.pattern).toBeNull();
    await expect(source.setTag(BOB, { who: 'anyone' })).rejects.toMatchObject({ code: 'not_connected' });
  });

  it('flat chat: the preceding messages up to the count, or since the previous tag', async () => {
    await connectAndArm();
    for (let i = 1; i <= 12; i += 1) say(`f${i}`, 'ch-support', '7', `line ${i}`, i);
    say('t1', 'ch-support', ME, '#помічник first', 13);
    await next();
    let [request] = await core.listRequests(ADA);
    let [, text] = await firstLine(request!.id);
    expect(text).not.toContain('line 2\n');
    expect(text.match(/> line \d+/g)).toEqual(['line 3', 'line 4', 'line 5', 'line 6', 'line 7', 'line 8', 'line 9', 'line 10', 'line 11', 'line 12'].map(line => `> ${line}`));
    expect(text.endsWith('\n\nfirst')).toBe(true);

    // A second tag in the same flat chat is a new request, with only what came after the first tag.
    say('f13', 'ch-support', '8', 'line 13', 80);
    say('t2', 'ch-support', ME, '#помічник second', 81);
    await next();
    const requests = await core.listRequests(ADA);
    expect(requests).toHaveLength(2);
    request = requests.find(candidate => candidate.sourceKey?.endsWith(':t2'));
    [, text] = await firstLine(request!.id);
    expect(text).toBe(['> **Taras** · 2026-11-15 10:01 UTC', '> line 13', '', 'second'].join('\n'));

    // A smaller count.
    await source.setTag(ADA, { contextMessages: 1 });
    say('f14', 'ch-support', '7', 'line 14', 140);
    say('f15', 'ch-support', '7', 'line 15', 141);
    say('t3', 'ch-support', ME, '#помічник third', 142);
    await next();
    request = (await core.listRequests(ADA)).find(candidate => candidate.sourceKey?.endsWith(':t3'));
    [, text] = await firstLine(request!.id);
    expect(text).toContain('line 15');
    expect(text).not.toContain('line 14');
  });

  it('thread: the parent and the replies before the tag; a later tag there joins the open request with what came since', async () => {
    await connectAndArm();
    say('r', 'ch-general', '7', 'Checkout broke', 5);
    say('r1', 'ch-general', '8', 'for me too', 6, { parent: 'r' });
    say('r2', 'ch-general', ME, '#помічник що там?', 7, { parent: 'r' });
    say('x', 'ch-general', '8', 'unrelated chatter in the channel', 8);
    await next();
    const [request] = await core.listRequests(ADA);
    expect(request).toMatchObject({ sourceKey: `clickup:${WS}:ch-general:r`, fromName: 'ada' });
    let lines = await sourceLines(request!.id);
    expect(lines).toHaveLength(1);
    expect(lines[0]![1]).toContain('> Checkout broke');
    expect(lines[0]![1]).toContain('> for me too');
    expect(lines[0]![1]).not.toContain('unrelated');
    expect(lines[0]![1].endsWith('що там?')).toBe(true);

    say('r3', 'ch-general', '7', 'fixed now?', 70, { parent: 'r' });
    say('r4', 'ch-general', ME, '#помічник перевір ще раз', 71, { parent: 'r' });
    await next();
    const requests = await core.listRequests(ADA);
    expect(requests).toHaveLength(1);
    lines = await sourceLines(request!.id);
    expect(lines).toHaveLength(2);
    expect(lines[1]![1]).toBe(['> **Olena** · 2026-11-15 10:01 UTC', '> fixed now?', '', 'перевір ще раз'].join('\n'));
    expect(brain.turns.map(turn => turn.first)).toEqual([true, false]);
  });

  it('a tag on a message, then a tag in its thread: one request', async () => {
    await connectAndArm();
    say('m', 'ch-general', ME, '#помічник ось баг з оплатою', 5);
    await next();
    say('m1', 'ch-general', '7', 'logs attached', 70, { parent: 'm' });
    say('m2', 'ch-general', ME, '#помічник ще логи', 71, { parent: 'm' });
    await next();
    const requests = await core.listRequests(ADA);
    expect(requests).toHaveLength(1);
    expect((await sourceLines(requests[0]!.id)).map(([, text]) => text)).toEqual([
      'ось баг з оплатою',
      ['> **Olena** · 2026-11-15 10:01 UTC', '> logs attached', '', 'ще логи'].join('\n'),
    ]);
  });

  it('a tag in a closed request’s thread opens a new request continuing it', async () => {
    await connectAndArm();
    say('m', 'ch-general', ME, '#помічник question one', 5);
    await next();
    const [first] = await core.listRequests(ADA);
    await service.close(ADA, first!.id);
    say('m1', 'ch-general', ME, '#помічник one more thing', 70, { parent: 'm' });
    await next();
    const requests = await core.listRequests(ADA);
    expect(requests).toHaveLength(2);
    const reopened = requests.find(request => request.id !== first!.id)!;
    expect(reopened).toMatchObject({ previousRequestId: first!.id, sourceKey: first!.sourceKey, status: 'waiting_me' });
    expect((await core.listMessages(ADA, reopened.id))[0]).toMatchObject({ author: 'event', text: `continues:${first!.id}` });
  });

  it('downloads the files of the tagged message and its context, ClickUp hosts only, each once', async () => {
    const shot = 'https://t9001.p.clickup-attachments.com/t9001/abc/shot.png';
    const doc = 'https://t9001.p.clickup-attachments.com/t9001/def/spec.pdf';
    clickup.files.set(shot, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]));
    clickup.files.set(doc, new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 1]));
    await connectAndArm();
    say('a1', 'dm-olena', '7', `See ![shot.png](${shot}) and [site](https://evil.example/x.png)`, 5);
    clickup.post({
      id: 'a2',
      channel: 'dm-olena',
      user: '7',
      content: '',
      date: T0 + 6000,
      extra: { attachments: [{ id: 'x', title: 'Spec', url: doc, mimetype: 'application/pdf' }, { id: 'y', title: 'again', url_w_host: shot }] },
    });
    say('a3', 'dm-olena', ME, '#помічник що тут?', 7);
    await next();
    const [request] = await core.listRequests(ADA);
    // The tagged message first, then its context newest first: the second link to the shot is named "again".
    expect((await core.listFiles(ADA, request!.id)).map(file => [file.name, file.mime]).sort()).toEqual([
      ['Spec', 'application/pdf'],
      ['again', 'image/png'],
    ]);
    expect(clickup.calls.some(call => call.includes('evil.example'))).toBe(false);
    expect(brain.turns[0]?.input.files).toHaveLength(2);
    // A file-only message is named in the quote.
    const [, text] = await firstLine(request!.id);
    expect(text).toContain('> [Spec] [again]');
  });

  it('a tag written before a chat’s first read is history: never taken', async () => {
    say('old', 'dm-olena', ME, '#помічник old', -60);
    await connectAndArm();
    await next();
    expect(await core.listRequests(ADA)).toEqual([]);
  });
});

describe('the channel modes and rules are gone', () => {
  /** A row as the per-channel settings left it (mode, rule, cursor long ago), written straight into the table. */
  async function legacyRow(channelId: string, mode: string, rule: string | null, kind: ChannelKind = 'channel') {
    const ops = (storage as unknown as { ops: { insertOne: (table: string, row: object) => Promise<unknown> } }).ops;
    await ops.insertOne(SOURCE_CHANNELS, {
      owner_org_id: ADA.orgId,
      owner_user_id: ADA.userId,
      platform: 'clickup',
      workspace_id: WS,
      channel_id: channelId,
      name: channelId,
      kind,
      mode,
      rule,
      following: true,
      hidden: false,
      visibility: null,
      location_kind: null,
      location_id: null,
      location_path: null,
      members: null,
      follower: null,
      details_at: null,
      details_error: null,
      cursor_at: T0 - 86_400_000,
      last_sync_at: null,
      last_error: null,
      gone: false,
      created_at: new Date(T0),
      updated_at: new Date(T0),
    });
  }

  it('old settings («Усе», digest only, ask a Factory) are migrated away: untagged traffic makes nothing, the tag works', async () => {
    await source.connect(ADA, clickup.token);
    const ops = (storage as unknown as { ops: { deleteMany: (table: string, where: object) => Promise<number> } }).ops;
    await ops.deleteMany(SOURCE_CHANNELS, {});
    await legacyRow('dm-olena', 'watch', null, 'dm');
    await legacyRow('ch-general', 'addressed', 'digest_only');
    await legacyRow('ch-support', 'ignore', 'analyse_and_ask:f-1');
    // Written while the chat was on «Усе», before the switch: never looked at for a tag.
    say('before', 'dm-olena', ME, '#помічник from before the switch', -30);
    now = T0;
    expect(await storage.retireChannelModes(new Date(now))).toBe(3);
    expect(await storage.retireChannelModes(new Date(now))).toBe(0);
    const rows = await (storage as unknown as { ops: { findMany: (table: string, where: object) => Promise<Array<Record<string, unknown>>> } }).ops.findMany(SOURCE_CHANNELS, {});
    expect(rows.map(row => [row.mode, row.rule, Number(row.cursor_at)])).toEqual(rows.map(() => [RETIRED_MODE, null, T0]));

    say('d1', 'dm-olena', '7', 'да', 5);
    say('g1', 'ch-general', '7', 'FYI: deploy at 5', 6);
    say('s1', 'ch-support', '7', 'Checkout fails', 7);
    await next();
    expect(await core.listRequests(ADA)).toEqual([]);
    expect(brain.turns).toEqual([]);
    expect(factory.asked).toEqual([]);

    say('s2', 'ch-support', ME, '#помічник оціни', 70);
    await next();
    const requests = await core.listRequests(ADA);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.status).toBe('waiting_me');
    // No rule runs: no Factory is asked on its own, no digest-only bypass.
    expect(factory.asked).toEqual([]);
    expect(brain.turns).toHaveLength(1);
  });

  it('the per-channel routes are gone; the tag route is the person’s own', async () => {
    await source.connect(ADA, clickup.token);
    const app = await sourcesApp();
    const headers = { 'x-user': 'ada', 'x-org': 'org-a', 'content-type': 'application/json' };
    const put = (path: string, body: object, as = headers) =>
      app.request(`http://localhost/web/assistant/sources/clickup${path}`, { method: 'PUT', headers: as, body: JSON.stringify(body) });
    expect((await put(`/channels/${WS}/ch-general`, { mode: 'watch' })).status).toBe(404);
    expect((await put('/dms', { mode: 'watch' })).status).toBe(404);
    const ok = await put('/tag', { pattern: '!!ai\\b', who: 'anyone', contextMessages: 5 });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { clickup: { tag: unknown } }).clickup.tag).toMatchObject({ pattern: '!!ai\\b', who: 'anyone', contextMessages: 5 });
    const bad = await put('/tag', { pattern: '.*' });
    expect(bad.status).toBe(400);
    expect((await put('/tag', {})).status).toBe(400);
    // Bob has no connection of his own; Ada's tag is not his to change.
    expect((await put('/tag', { who: 'me' }, { ...headers, 'x-user': 'bob' })).status).toBe(409);
    expect((await storage.getConnection(ADA))?.tag.who).toBe('anyone');
  });
});

/** The source's routes on a Hono app, the caller from `x-user` / `x-org`. */
async function sourcesApp() {
  const { Hono } = await import('hono');
  const { enforceRouteAccess } = await import('@factory/http');
  const { buildClickUpSourceRoutes } = await import('./routes.ts');
  const auth = {
    enabled: () => true,
    ensureUser: async () => undefined,
    tenant: (c: { req: { header: (name: string) => string | undefined } }) => {
      const userId = c.req.header('x-user');
      return userId ? { userId, orgId: c.req.header('x-org') ?? 'org-a', role: 'member' } : undefined;
    },
    can: async () => true,
  } as unknown as Parameters<typeof buildClickUpSourceRoutes>[0]['auth'];
  const app = new Hono();
  for (const route of enforceRouteAccess(buildClickUpSourceRoutes({ auth, source }), auth)) {
    app.on([route.method], route.path, c => (route as unknown as { handler: (c: unknown) => Promise<Response> }).handler(c));
  }
  return app;
}

describe('author names and attachments when the agent reads', () => {
  it('names a guest from the channel’s people, never shows a raw id, and lists the message’s files', async () => {
    await connectAndArm();
    clickup.workspaces[0]!.members.push({ user: { id: 99, username: '', email: '' } });
    const support = clickup.channels.find(channel => channel.id === 'ch-support')!;
    support.members = ['7', '99', '8'];
    const url = 'https://t9001.p.clickup-attachments.com/t9001/abc/log.txt';
    say('m1', 'ch-support', '8', `log: [log.txt](${url})`, 5);
    say('m2', 'ch-support', '99', 'who am I', 6);
    say('m3', 'ch-support', ME, '#помічник', 7);
    await next();
    const read = await source.readChannel(ADA, { ref: `clickup:${WS}:ch-support` });
    expect(read.messages).toMatchObject([
      { id: 'm1', from: 'Taras', attachments: [{ name: 'log.txt', url }] },
      { id: 'm2', from: null },
      { id: 'm3', from: 'ada' },
    ]);
    expect(JSON.stringify(read)).not.toContain('"from":"99"');
  });

  it('downloads a ClickUp file for the agent with the person’s token, and leaves other hosts to the core', async () => {
    const url = 'https://t9001.p.clickup-attachments.com/t9001/abc/shot.png';
    clickup.files.set(url, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]));
    await expect(source.download(ADA, url, 1000)).rejects.toMatchObject({ code: 'not_connected' });
    await source.connect(ADA, clickup.token);
    expect(await source.download(ADA, 'https://example.org/a.png', 1000)).toBeNull();
    const file = await source.download(ADA, url, 1000);
    expect(file?.bytes.byteLength).toBe(9);
    await expect(source.download(ADA, url, 4)).rejects.toMatchObject({ code: 'file_too_large' });
  });

  it('the agent reads only chats where its owner tagged it, within the read budget', async () => {
    await connectAndArm();
    await source.connect(BOB, clickup.token);
    say('m1', 'ch-support', '7', 'is checkout fixed?', 5);
    say('m2', 'ch-support', ME, '#помічник', 6);
    say('m3', 'ch-general', '7', 'lunch?', 7);
    await next();

    expect((await source.taggedChannels(ADA)).map(channel => channel.ref)).toEqual([`clickup:${WS}:ch-support`]);
    clickup.calls.length = 0;
    const read = await source.readChannel(ADA, { ref: `clickup:${WS}:ch-support` });
    expect(read.messages).toMatchObject([{ id: 'm1', from: 'Olena', text: 'is checkout fixed?' }, { id: 'm2' }]);
    expect(clickup.calls.length).toBeLessThanOrEqual(source.limits.callsPerRead);

    // Never tagged by Ada, and Bob tagged nothing (Ada's tag is not his): refused, nothing read.
    clickup.calls.length = 0;
    await expect(source.readChannel(ADA, { ref: `clickup:${WS}:ch-general` })).rejects.toMatchObject({ status: 404 });
    await expect(source.readChannel(BOB, { ref: `clickup:${WS}:ch-support` })).rejects.toMatchObject({ status: 404 });
    await expect(source.readChannel(ADA, { ref: 'clickup:other:thing:extra' })).rejects.toMatchObject({ status: 404 });
    expect(clickup.calls).toEqual([]);

    // Through the core, as the agent's tool does.
    expect((await service.listTaggedChannels(BOB)).map(channel => channel.name)).toEqual([]);
    expect((await service.listTaggedChannels(ADA)).map(channel => channel.name)).toEqual(['support']);
  });
});

describe('message attachments', () => {
  it('reads attachment fields and Markdown links, ClickUp hosts only, once each', () => {
    const a = 'https://x.clickup-attachments.com/f/a.png';
    expect(
      messageAttachments({
        content: `![a](${a}) [b](https://x.clickup-attachments.com/f/b.zip)`,
        files: [{ name: 'a.png', download_url: a, mime_type: 'image/png' }, { url: 'https://other.example/c.png' }],
      }),
    ).toEqual([
      { name: 'a.png', url: a, mime: 'image/png' },
      { name: 'b', url: 'https://x.clickup-attachments.com/f/b.zip', mime: null },
    ]);
  });
});

describe('limits and failures', () => {
  it('past the hourly turn limit tags are kept as requests but not analysed', async () => {
    build({ turnsPerHour: 1 });
    await connectAndArm();
    say('m1', 'ch-general', ME, '#помічник one', 5);
    say('m2', 'ch-general', ME, '#помічник two', 6);
    await next();
    expect(brain.turns).toHaveLength(1);
    const second = (await core.listRequests(ADA)).find(request => request.sourceKey?.endsWith(':m2'))!;
    expect(second.status).toBe('waiting_me');
    expect((await core.listMessages(ADA, second.id)).map(message => message.text)).toContain('not_analysed:limit');
  });

  it('a poll spends at most its call budget; a tag in a chat it did not reach is found on a later poll', async () => {
    await connectAndArm();
    build({ callsPerPoll: 3 });
    say('t1', 'ch-support', ME, '#помічник late', 5);
    let found = 0;
    for (let round = 0; round < 4 && found === 0; round += 1) {
      clickup.calls.length = 0;
      found += (await next()).ingested;
      expect(clickup.calls.length).toBeLessThanOrEqual(3);
    }
    expect(found).toBe(1);
    expect(await core.listRequests(ADA)).toHaveLength(1);
  });

  it('chats outside the sidebar are looked at less often than the sidebar', async () => {
    clickup.channels.push({ id: 'ch-far', name: 'far away', type: 'CHANNEL', following: false });
    await connectAndArm();
    build({ channelsPerPoll: 1 });
    const reads: string[] = [];
    const round = async () => {
      clickup.calls.length = 0;
      now += 1000;
      await poll();
      reads.push(...clickup.calls.filter(call => call.includes('/messages?')).map(call => call.split('/channels/')[1]!.split('/')[0]!));
    };
    for (let i = 0; i < 6; i += 1) await round();
    // Six polls, one chat each: the three sidebar chats twice, the one outside not yet (it waits 10 minutes).
    expect(reads.filter(id => id === 'ch-far')).toEqual([]);
    expect(new Set(reads)).toEqual(new Set(['dm-olena', 'ch-general', 'ch-support']));
    now += source.limits.offSidebarDelayMs;
    for (let i = 0; i < 4; i += 1) await round();
    expect(reads.filter(id => id === 'ch-far')).toEqual(['ch-far']);
  });

  it('backs off after failures, waits for the rate-limit reset, and stops on a rejected token', async () => {
    await connectAndArm();
    clickup.failWith = { status: 500 };
    await poll();
    let connection = await storage.getConnection(ADA);
    expect(connection?.failures).toBe(1);
    expect(connection?.nextPollAt?.getTime()).toBe(now + 2 * source.limits.intervalMs);
    expect(connection?.lastError).toContain('500');

    clickup.failWith = { status: 429, reset: Math.floor((now + 3_600_000) / 1000) };
    await poll();
    connection = await storage.getConnection(ADA);
    expect(connection?.nextPollAt?.getTime()).toBe(Math.floor((now + 3_600_000) / 1000) * 1000);

    clickup.failWith = { status: 401 };
    await poll();
    connection = await storage.getConnection(ADA);
    expect(connection).toMatchObject({ status: 'rejected', nextPollAt: null });
    now += 10 * 3_600_000;
    expect(await source.due(10)).toEqual([]);

    clickup.failWith = null;
    await source.connect(ADA, clickup.token);
    expect((await storage.getConnection(ADA))?.status).toBe('active');
  });

  it('the scheduler polls only people with a due connection, a bounded number per tick', async () => {
    await source.connect(ADA, clickup.token);
    await source.connect(BOB, clickup.token);
    await source.connect(ADA_ELSEWHERE, clickup.token);
    const polled: string[] = [];
    const polling = startClickUpPolling(
      {
        due: limit => source.due(limit),
        poll: async owner => {
          polled.push(`${owner.orgId}/${owner.userId}`);
          return source.poll(owner);
        },
      },
      { ownersPerTick: 2, firstTickAfterMs: 1e9, tickMs: 1e9 },
    );
    try {
      expect(await polling.tick()).toBe(2);
      expect(await polling.tick()).toBe(1);
      expect(await polling.tick()).toBe(0); // all polled, next due after the interval
      now += source.limits.intervalMs;
      expect(await polling.tick()).toBe(2);
      expect(new Set(polled).size).toBe(3);
    } finally {
      polling.stop();
    }
  });
});

describe('owners and cleanup', () => {
  it('keeps each owner’s connection, tag and requests apart', async () => {
    await connectAndArm(ADA);
    await source.connect(BOB, clickup.token);
    await source.setTag(BOB, { pattern: '!!bob\\b' });
    say('m1', 'ch-general', ME, '#помічник for Ada’s tag', 5);
    await next(ADA);
    await poll(BOB);
    expect(await core.listRequests(ADA)).toHaveLength(1);
    expect(await core.listRequests(BOB)).toEqual([]);
    expect((await source.view(ADA)).tag.pattern).toBeNull();
    expect((await source.view(ADA_ELSEWHERE)).connected).toBe(false);
    await expect(source.setTag(ADA_ELSEWHERE, { who: 'anyone' })).rejects.toMatchObject({ code: 'not_connected' });
  });

  it('erasing the assistant disconnects the source first and polling stops', async () => {
    await connectAndArm();
    await source.connect(BOB, clickup.token);
    say('m1', 'ch-general', ME, '#помічник hello', 5);
    await next();
    await service.clear(ADA, { reason: 'cleared_by_person', actorId: 'ada' });
    expect((await source.view(ADA)).connected).toBe(false);
    expect(await core.listRequests(ADA)).toEqual([]);
    now += 3_600_000;
    expect(await source.due(10)).toEqual([BOB]);
    clickup.calls.length = 0;
    await poll(ADA);
    expect(clickup.calls).toEqual([]);
    // Bob's connection is untouched.
    expect((await source.view(BOB)).connected).toBe(true);
  });

  it('a deleted account is erased in every organization it has only a connection in', async () => {
    await source.connect(ADA_ELSEWHERE, clickup.token);
    expect(await service.clearUser('ada', { reason: 'account_deleted', actorId: 'system' })).toBe(1);
    expect(await storage.organizationsOf('ada')).toEqual([]);
    expect(SOURCE_CONNECTIONS).toBe('assistant_source_connections');
  });

  it('disconnect forgets the token, the tag and the cursors but keeps the person’s requests', async () => {
    await connectAndArm();
    say('m1', 'ch-general', ME, '#помічник hello', 5);
    await next();
    await source.disconnect(ADA);
    expect(await storage.getConnection(ADA)).toBeNull();
    expect(await storage.listChannels(ADA)).toEqual([]);
    expect(await core.listRequests(ADA)).toHaveLength(1);
  });
});

describe('the client', () => {
  it('sends the personal token as is and reads the documented shapes', async () => {
    const client = new ClickUpChatClient({ token: clickup.token, fetch: clickup.fetch });
    expect(await client.me()).toEqual({ id: '42', username: 'ada', email: 'ada@example.com' });
    const channels = await client.channels(WS);
    expect(channels.items.map(channel => channel.type)).toEqual(['CHANNEL', 'CHANNEL', 'DM']);
    clickup.post({ id: 'x1', channel: 'ch-general', user: '7', content: 'hi', date: T0 });
    clickup.post({ id: 'x2', channel: 'ch-general', user: '7', content: 'reply', date: T0 + 1, parent: 'x1' });
    const page = await client.messages(WS, 'ch-general');
    expect(page.items).toEqual([
      { id: 'x1', content: 'hi', date: T0, userId: '7', channelId: 'ch-general', parentMessageId: null, repliesCount: 1, attachments: [] },
    ]);
    expect((await client.replies(WS, 'ch-general', 'x1')).items[0]).toMatchObject({ id: 'x2', parentMessageId: 'x1' });
  });

  it('pages newest first with the cursor', async () => {
    clickup.pageSize = 2;
    for (let i = 0; i < 5; i += 1) clickup.post({ id: `p${i}`, channel: 'ch-general', user: '7', content: String(i), date: T0 + i });
    const client = new ClickUpChatClient({ token: clickup.token, fetch: clickup.fetch });
    const first = await client.messages(WS, 'ch-general', { limit: 2 });
    expect(first.items.map(message => message.id)).toEqual(['p4', 'p3']);
    const second = await client.messages(WS, 'ch-general', { limit: 2, cursor: first.nextCursor });
    expect(second.items.map(message => message.id)).toEqual(['p2', 'p1']);
  });

  it('gives the token only to ClickUp’s file hosts', () => {
    expect(isClickUpFileUrl('https://t1.p.clickup-attachments.com/a/b.png')).toBe(true);
    expect(isClickUpFileUrl('https://evil.example/clickup.com/b.png')).toBe(false);
    expect(isClickUpFileUrl('http://t1.p.clickup-attachments.com/a/b.png')).toBe(false);
    expect(fileLinks('![a](https://app.clickup.com/9001/v/l/abc) ![b](https://x.clickup-attachments.com/f/b.pdf)')).toEqual([
      { name: 'b', url: 'https://x.clickup-attachments.com/f/b.pdf' },
    ]);
  });
});

describe('the chat list: names, locations and the person’s ClickUp sidebar', () => {
  /**
   * Shaped like the person's workspace: plain channels they follow, «Bugs» and «Development» as
   * List/Folder channels in several places (same name, different location), DMs without names,
   * a group DM, a DM they hid.
   */
  function sidebarFixture() {
    clickup.workspaces[0]!.members.push({ user: { id: 9, username: 'Iryna', email: 'iryna@example.com' } });
    clickup.channels = [
      { id: 'ch-albi', name: 'Albi', type: 'CHANNEL', following: true, parent: { id: 'sp-albi', type: 4 }, is_canonical_channel: true },
      { id: 'ch-bookfate', name: 'BookFate', type: 'CHANNEL', following: true },
      { id: 'ch-bugs-1', name: 'Bugs', type: 'CHANNEL', following: true, parent: { id: 'l-1', type: 6 } },
      { id: 'ch-bugs-2', name: 'Bugs', type: 'CHANNEL', following: false, parent: { id: 'l-2', type: 6 } },
      { id: 'ch-bugs-3', name: 'Bugs', type: 'CHANNEL', following: false, parent: { id: 'l-3', type: 6 } },
      { id: 'ch-dev-1', name: 'Development', type: 'CHANNEL', following: false, parent: { id: 'f-1', type: 5 } },
      { id: 'ch-dev-2', name: 'Development', type: 'CHANNEL', following: false, parent: { id: 'f-2', type: 5 } },
      { id: 'dm-olena', name: '', type: 'DM', following: true, members: ['42', '7'] },
      { id: 'dm-taras', name: '', type: 'DM', following: true, members: ['42', '8'] },
      { id: 'dm-old', name: '', type: 'DM', following: false, is_hidden: true, members: ['42', '9'] },
      { id: 'gdm-1', name: '', type: 'GROUP_DM', following: true, members: ['42', '7', '8'] },
    ];
    clickup.locations = {
      'space:sp-albi': { id: 'sp-albi', name: 'Albi' },
      'list:l-1': { id: 'l-1', name: 'Bugs', folder: { id: 'f-a', name: 'Syncta', hidden: false }, space: { id: 's-1', name: 'Clients' } },
      'list:l-2': { id: 'l-2', name: 'Bugs', folder: { id: 'f-b', name: 'KidNation', hidden: false }, space: { id: 's-1', name: 'Clients' } },
      'list:l-3': { id: 'l-3', name: 'Bugs', folder: { id: 'hidden', name: 'hidden', hidden: true }, space: { id: 's-2', name: 'Internal' } },
      'folder:f-1': { id: 'f-1', name: 'Development', space: { id: 's-1', name: 'Clients' } },
      'folder:f-2': { id: 'f-2', name: 'Development', space: { id: 's-2', name: 'Internal' } },
    };
  }

  /** Channels described: one `…/members` (a DM) or `…/followers` (a channel) call each. */
  const lookups = () => clickup.calls.filter(call => /\/(members|followers)\?/.test(call)).length;

  it('names each DM after its people, tells location channels apart by path, and marks the sidebar', async () => {
    sidebarFixture();
    const view = await source.connect(ADA, clickup.token);
    expect(view.chats).toEqual({ total: 11, inSidebar: 6 });
    const chats = await chatList();
    const rows = chats.map(({ name, kind, location, inSidebar }) => ({ name, kind, location, inSidebar }));
    expect(rows).toEqual([
      { name: 'Iryna', kind: 'dm', location: null, inSidebar: false },
      { name: 'Olena', kind: 'dm', location: null, inSidebar: true },
      { name: 'Taras', kind: 'dm', location: null, inSidebar: true },
      { name: 'Olena, Taras', kind: 'group_dm', location: null, inSidebar: true },
      { name: 'Albi', kind: 'channel', location: 'space:Albi', inSidebar: true },
      { name: 'BookFate', kind: 'channel', location: null, inSidebar: true },
      { name: 'Bugs', kind: 'channel', location: 'list:Clients › KidNation › Bugs', inSidebar: false },
      { name: 'Bugs', kind: 'channel', location: 'list:Clients › Syncta › Bugs', inSidebar: true },
      { name: 'Bugs', kind: 'channel', location: 'list:Internal › Bugs', inSidebar: false },
      { name: 'Development', kind: 'channel', location: 'folder:Clients › Development', inSidebar: false },
      { name: 'Development', kind: 'channel', location: 'folder:Internal › Development', inSidebar: false },
    ]);
    // Never two rows that read the same.
    const labels = rows.map(row => `${row.kind}|${row.name}|${row.location}`);
    expect(new Set(labels).size).toBe(labels.length);
    // The person themself is not one of a DM's people; the avatar comes from the workspace member.
    expect(chats.find(channel => channel.channelId === 'dm-olena')!.members).toEqual([
      { id: '7', name: 'Olena', avatarUrl: 'https://attachments.clickup.com/profilePictures/7_olena.jpg' },
    ]);
  });

  it('looks details up within its limit, sidebar first, keeps them, and asks again only after a day', async () => {
    sidebarFixture();
    build({ detailsPerListing: 3 });
    await source.connect(ADA, clickup.token);
    expect(lookups()).toBe(3);
    // Sidebar rows first: a followed DM is named even with the small budget; the hidden one is not yet.
    const first = await chatList();
    expect(first.filter(channel => channel.kind !== 'channel' && channel.members.length > 0).every(channel => channel.inSidebar)).toBe(true);
    // The next poll (no new listing) goes on with the rest, 3 at a time.
    clickup.calls.length = 0;
    now += 1000;
    await poll();
    expect(lookups()).toBe(3);
    build();
    clickup.calls.length = 0;
    await source.syncNow(ADA);
    // The other 5 of the 11 (every channel is asked for its followers); none twice.
    expect(lookups()).toBe(5);
    clickup.calls.length = 0;
    await source.syncNow(ADA);
    expect(lookups()).toBe(0);
    now += 25 * 60 * 60 * 1000;
    clickup.calls.length = 0;
    await source.syncNow(ADA);
    expect(lookups()).toBe(11);
  });

  it('names where a request came from with its location, and a DM by its person', async () => {
    sidebarFixture();
    await source.connect(ADA, clickup.token);
    // Every chat is looked at (11 chats, within one poll's reach), outside the sidebar too.
    now += 1000;
    await poll();
    now += source.limits.offSidebarDelayMs;
    await poll();
    clickup.post({ id: 'b1', channel: 'ch-bugs-2', user: ME, content: 'crash on login #помічник', date: now + 5000 });
    clickup.post({ id: 'd1', channel: 'dm-olena', user: ME, content: '#помічник', date: now + 6000 });
    now += source.limits.offSidebarDelayMs + 60_000;
    await poll();
    expect(brain.turns.map(turn => turn.input.text.split('\n')[0]).sort()).toEqual(['(#Clients › KidNation › Bugs)', '(DM Olena)']);
    expect((await source.taggedChannels(ADA)).map(channel => channel.name).sort()).toEqual(['Bugs', 'Olena']);
  });
});

describe('live ClickUp shapes, failures made visible, and diagnostics', () => {
  /** Shaped like the person's real workspace: DMs named "DM", channels followed only per `…/followers`. */
  function liveFixture() {
    clickup.channels = [
      { id: 'ch-switch5', name: 'SWITCH5', type: 'CHANNEL', following: false, followers: ['42', '7'], parent: { id: 'sp-1', type: 4 } },
      { id: 'ch-syncta', name: 'Syncta', type: 'CHANNEL', following: false, followers: ['42'] },
      { id: 'ch-other', name: 'Other team', type: 'CHANNEL', following: false, followers: ['7'] },
      { id: 'dm-olena', name: 'DM', type: 'DM', members: ['42', '7'] },
      { id: 'dm-taras', name: 'DM', type: 'DM', members: ['42', '8'] },
    ];
    clickup.locations = { 'space:sp-1': { id: 'sp-1', name: 'SWITCH5' } };
  }

  it('names a DM ClickUp calls "DM" after its people, when members come back with only id and email', async () => {
    liveFixture();
    clickup.memberShape = 'bare';
    await source.connect(ADA, clickup.token);
    const dms = (await chatList()).filter(channel => channel.kind === 'dm');
    expect(dms.map(channel => [channel.name, channel.members.map(member => member.name), channel.detailsError])).toEqual([
      ['Olena', ['Olena'], null],
      ['Taras', ['Taras'], null],
    ]);
  });

  it('takes members that come back as bare ids too', async () => {
    liveFixture();
    clickup.memberShape = 'ids';
    await source.connect(ADA, clickup.token);
    expect((await chatList()).filter(channel => channel.kind === 'dm').map(channel => channel.name)).toEqual(['Olena', 'Taras']);
  });

  it('is_follower is only a filter: the full list is asked without it, and …/followers finds the sidebar the filter missed', async () => {
    liveFixture();
    await source.connect(ADA, clickup.token);
    const listing = clickup.calls.filter(call => call.includes('/chat/channels?'));
    expect(listing.some(call => call.includes('is_follower=true'))).toBe(true);
    expect(listing.some(call => !call.includes('is_follower'))).toBe(true);
    expect(listing.some(call => call.includes('is_follower=false'))).toBe(false);
    const sidebar = Object.fromEntries((await chatList()).map(channel => [channel.name, channel.inSidebar]));
    expect(sidebar).toEqual({ Olena: true, Taras: true, 'Other team': false, SWITCH5: true, Syncta: true });
  });

  it('rows listed before the sidebar facts existed are listed again on the next poll', async () => {
    liveFixture();
    await source.connect(ADA, clickup.token);
    const ops = (storage as unknown as { ops: { updateAtomic: (...args: unknown[]) => Promise<unknown> } }).ops;
    for (const id of ['ch-syncta', 'dm-olena']) {
      await ops.updateAtomic(
        'assistant_source_channels',
        { owner_org_id: ADA.orgId, owner_user_id: ADA.userId, platform: 'clickup', workspace_id: WS, channel_id: id },
        () => ({ following: null, follower: null, members: null, details_at: null }),
      );
    }
    clickup.calls.length = 0;
    now += 1000;
    await poll();
    expect(clickup.calls.some(call => call.includes('is_follower=true'))).toBe(true);
    const chats = await chatList();
    expect(chats.find(channel => channel.channelId === 'ch-syncta')?.inSidebar).toBe(true);
    expect(chats.find(channel => channel.channelId === 'dm-olena')?.name).toBe('Olena');
  });

  it('a lookup ClickUp refuses shows its code on the row and is tried again after a while', async () => {
    liveFixture();
    clickup.failPaths = [{ path: /\/members$/, status: 403 }];
    await source.connect(ADA, clickup.token);
    let view = await chatList();
    const olena = () => view.find(channel => channel.channelId === 'dm-olena')!;
    expect(olena().detailsError).toEqual({ what: 'members', code: '403' });
    expect(olena().members).toEqual([]);
    clickup.failPaths = [];
    now += 60_000;
    await poll();
    view = await chatList();
    expect(olena().detailsError).toEqual({ what: 'members', code: '403' });
    now += source.limits.detailsRetryMs;
    await poll();
    view = await chatList();
    expect(olena()).toMatchObject({ name: 'Olena', detailsError: null });
  });

  it('a members list that comes back empty is a visible failure, not a silent blank', async () => {
    liveFixture();
    clickup.channels.find(channel => channel.id === 'dm-taras')!.members = [];
    await source.connect(ADA, clickup.token);
    expect((await chatList()).find(channel => channel.channelId === 'dm-taras')!.detailsError).toEqual({ what: 'members', code: 'empty' });
  });

  it('«fetch failed» is tried again with backoff; past the tries the cause code is what the person sees', async () => {
    await connectAndArm();
    sleeps = [];
    clickup.networkFailures = 2;
    now += 10 * 60_000;
    const ok = await poll();
    expect(ok.error).toBeUndefined();
    expect(sleeps).toEqual([500, 1000]);
    clickup.networkFailures = 3;
    clickup.networkCode = 'UND_ERR_CONNECT_TIMEOUT';
    now += 10 * 60_000;
    const failed = await poll();
    expect(failed.error).toContain('UND_ERR_CONNECT_TIMEOUT');
    const connection = await storage.getConnection(ADA);
    expect(connection?.lastError).toContain('UND_ERR_CONNECT_TIMEOUT');
    expect(connection?.failures).toBe(1);
    const diagnostics = await source.diagnostics(ADA);
    expect(diagnostics.lastRead?.calls.at(-1)).toMatchObject({ status: 0, attempts: 3, errorCode: 'UND_ERR_CONNECT_TIMEOUT' });
  });

  it('diagnostics carry shapes, counts and enum values — never names, ids, message text or the token', async () => {
    liveFixture();
    clickup.memberShape = 'bare';
    const logged: string[] = [];
    const info = console.info;
    console.info = (...args: unknown[]) => void logged.push(args.map(String).join(' '));
    try {
      await source.connect(ADA, clickup.token);
      now += 1000;
      await poll();
      clickup.post({ id: 'm1', channel: 'dm-olena', user: '7', content: 'secret client words', date: now + 5000 });
      now += 3 * 60_000;
      await poll();
    } finally {
      console.info = info;
    }
    const diagnostics = await source.diagnostics(ADA);
    expect(diagnostics.channels).toMatchObject({
      total: 5,
      byKind: { channel: 3, dm: 2, group_dm: 0 },
      followingByFilter: 0,
      followerByEndpoint: 2,
      dmsWithPeople: 2,
      dmsWithoutPeople: 0,
      lookupFailures: {},
    });
    const messages = diagnostics.lastRead!.calls.filter(call => call.endpoint === 'v3.chat.messages');
    expect(messages.find(call => call.count === 1)).toMatchObject({ status: 200, count: 1, itemKinds: ['object'] });
    const everything = JSON.stringify(diagnostics) + logged.join('\n');
    expect(logged.length).toBeGreaterThan(0);
    for (const secret of [clickup.token, 'Olena', 'olena@example.com', 'secret client words', 'SWITCH5', 'dm-olena', 'ch-syncta', WS]) {
      expect(everything).not.toContain(secret);
    }
    const channelsCall = logged.find(line => line.includes('"endpoint":"v3.chat.channels"'))!;
    expect(channelsCall).toContain('"type":["CHANNEL","DM"]');
    expect(channelsCall).toContain('https://api.clickup.com/api/v3/workspaces/{id}/chat/channels/{id}/members');
  });

  it('GET …/clickup/diagnostics answers only the caller about their own connection', async () => {
    liveFixture();
    await source.connect(ADA, clickup.token);
    const app = await sourcesApp();
    const get = (headers: Record<string, string>) => app.request('http://localhost/web/assistant/sources/clickup/diagnostics', { headers });
    const ada = await get({ 'x-user': 'ada', 'x-org': 'org-a' });
    expect(ada.status).toBe(200);
    const body = (await ada.json()) as { diagnostics: { channels: { total: number }; lastRead: { calls: unknown[] } } };
    expect(body.diagnostics.channels.total).toBe(5);
    expect(body.diagnostics.lastRead.calls.length).toBeGreaterThan(0);
    expect(JSON.stringify(body)).not.toContain(clickup.token);
    expect(JSON.stringify(body)).not.toContain('Olena');
    // Bob in the same organization has no connection: he sees nothing of Ada's.
    const bob = await get({ 'x-user': 'bob', 'x-org': 'org-a' });
    expect(bob.status).toBe(409);
    expect(JSON.stringify(await bob.json())).not.toContain('v3.chat');
    // Ada in another organization is another owner: nothing either.
    expect((await get({ 'x-user': 'ada', 'x-org': 'org-b' })).status).toBe(409);
    expect((await get({})).status).toBeGreaterThanOrEqual(401);
  });
});

describe('the client against documented and live shapes', () => {
  it('summarises an answer without content', () => {
    expect(urlTemplate('https://api.clickup.com/api/v3/workspaces/9001/chat/channels/8cr-abc/members')).toBe(
      'https://api.clickup.com/api/v3/workspaces/{id}/chat/channels/{id}/members',
    );
    const shape = shapeOf({
      next_cursor: 'abc',
      data: [
        {
          id: '1',
          name: 'Secret name',
          type: 'DM',
          parent: { id: '9001', type: 7 },
          is_hidden: false,
          links: { members: '/api/v3/workspaces/9001/chat/channels/1/members' },
        },
        'bare-id',
      ],
    });
    expect(shape).toEqual({
      keys: ['data', 'next_cursor'],
      nextCursor: true,
      count: 2,
      itemKeys: ['id', 'is_hidden', 'links', 'name', 'parent', 'type'],
      itemKinds: ['object', 'string'],
      enums: { is_hidden: ['false'], 'links.members': ['/api/v3/workspaces/{id}/chat/channels/{id}/members'], 'parent.type': ['7'], type: ['DM'] },
    });
    expect(JSON.stringify(shape)).not.toContain('Secret');
  });

  it('reads ChatSimpleUser, bare ids and v2-nested users as members', () => {
    expect(toMember({ id: '7', email: 'o@example.com' })).toEqual({ id: '7', name: '', email: 'o@example.com' });
    expect(toMember({ id: 7, email: 'o@example.com', name: 'Olena' })).toEqual({ id: '7', name: 'Olena', email: 'o@example.com' });
    expect(toMember('7')).toEqual({ id: '7', name: '' });
    expect(toMember({ user: { id: 7, username: 'Olena' } })).toEqual({ id: '7', name: 'Olena' });
    expect(toMember({})).toBeNull();
  });
});
