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
import { ClickUpChatSource, ORG_CONNECTION_GONE } from './source.ts';
import { ClickUpSourceStorage, SOURCE_CONNECTIONS } from './storage.ts';

const ADA: AssistantOwner = { orgId: 'org-a', userId: 'ada' };
const ADA_ELSEWHERE: AssistantOwner = { orgId: 'org-b', userId: 'ada' };
const BOB: AssistantOwner = { orgId: 'org-a', userId: 'bob' };
const WS = '9001';
const T0 = Date.parse('2026-11-15T10:00:00Z');

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
    ingest: { ingestSourceMessage: (o, m) => service.ingestSourceMessage(o, m), hasOpenSourceRequest: (o, k) => service.hasOpenSourceRequest(o, k) },
    client: options => new ClickUpChatClient({ ...options, fetch: clickup.fetch, sleep: async ms => void sleeps.push(ms) }),
    limits,
    checkRule: (owner, rule) => service.checkChannelRule(owner, rule),
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

async function connectAndWatch(channel: string, mode: 'watch' | 'addressed' = 'watch', owner = ADA) {
  await source.connect(owner, clickup.token);
  await source.setMode(owner, { workspaceId: WS, channelId: channel, mode });
  now += 1000;
  await poll(owner); // the first read only sets the cursor
}

describe('connecting a personal token', () => {
  it('refuses what is not a personal token, and a token ClickUp does not accept', async () => {
    await expect(source.connect(ADA, 'Bearer abc')).rejects.toMatchObject({ code: 'invalid_token' });
    await expect(source.connect(ADA, 'pk_00000000_WRONG')).rejects.toMatchObject({ code: 'token_rejected' });
    expect((await source.view(ADA)).connected).toBe(false);
  });

  it('stores the token encrypted, never shows it, and lists channels: DMs addressed, channels ignored', async () => {
    const view = await source.connect(ADA, clickup.token);
    expect(view.account).toEqual({ id: '42', name: 'ada' });
    expect(JSON.stringify(view)).not.toContain(clickup.token);
    const stored = await storage.getConnection(ADA);
    expect(stored?.secret.startsWith('enc:')).toBe(true);
    expect(stored?.secret).not.toContain(clickup.token);
    expect(view.channels.map(channel => [channel.name, channel.kind, channel.mode])).toEqual([
      ['Olena', 'dm', 'addressed'],
      ['general', 'channel', 'ignore'],
      ['support', 'channel', 'ignore'],
    ]);
  });

  it('keeps the person’s modes when the channel list is read again, and marks channels gone', async () => {
    await source.connect(ADA, clickup.token);
    await source.setMode(ADA, { workspaceId: WS, channelId: 'ch-general', mode: 'watch' });
    clickup.channels = clickup.channels.filter(channel => channel.id !== 'ch-support');
    await source.syncNow(ADA);
    const view = await source.view(ADA);
    expect(view.channels.map(channel => [channel.name, channel.mode])).toEqual([
      ['Olena', 'addressed'],
      ['general', 'watch'],
    ]);
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
    await source.setMode(ADA, { workspaceId: WS, channelId: 'ch-general', mode: 'watch' });
    now += 1000;
    await poll();
    clickup.post({ id: 'm1', channel: 'ch-general', user: '7', content: 'Checkout fails', date: now + 5000 });
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

  it('the agent’s on-demand read and channel rules work on the organization’s connection too', async () => {
    await source.connectOrg(ADA);
    await source.setMode(ADA, { workspaceId: WS, channelId: 'ch-support', mode: 'watch' });
    await source.setChannel(ADA, { workspaceId: WS, channelId: 'ch-support', rule: { kind: 'digest_only' } });
    clickup.post({ id: 'm1', channel: 'ch-support', user: '7', content: 'is checkout fixed?', date: T0 + 5000 });
    const read = await source.readChannel(ADA, { ref: `clickup:${WS}:ch-support` });
    expect(read.messages).toMatchObject([{ id: 'm1', from: 'Olena' }]);
    expect(read.channel.rule).toEqual({ kind: 'digest_only' });
    org = null;
    await expect(source.readChannel(ADA, { ref: `clickup:${WS}:ch-support` })).rejects.toMatchObject({ code: 'not_connected' });
  });

  it('keeps the personal-token path', async () => {
    const view = await source.connect(BOB, clickup.token);
    expect(view).toMatchObject({ connected: true, via: 'personal' });
  });
});

describe('reading channels by mode', () => {
  it('never reads an ignored channel, and turning one on does not read its history', async () => {
    clickup.post({ id: 'old', channel: 'ch-general', user: '7', content: 'old news', date: T0 - 60_000 });
    await source.connect(ADA, clickup.token);
    clickup.calls.length = 0;
    await poll();
    expect(clickup.calls.some(call => call.includes('ch-general'))).toBe(false);

    await source.setMode(ADA, { workspaceId: WS, channelId: 'ch-general', mode: 'watch' });
    await poll();
    expect(await core.listRequests(ADA)).toEqual([]);
  });

  it('watch: a new thread is a request (topic from the agent, from, link), replies join it, idempotently', async () => {
    await connectAndWatch('ch-general');
    clickup.post({ id: 'm1', channel: 'ch-general', user: '7', content: 'Checkout fails for client X', date: T0 + 5000 });
    now += 60_000;
    await poll();

    let [request] = await core.listRequests(ADA);
    expect(request).toMatchObject({
      source: 'clickup',
      fromName: 'Olena',
      topic: 'Topic of Olena',
      sourceKey: `clickup:${WS}:ch-general:m1`,
      sourceUrl: `https://app.clickup.com/${WS}/chat/r/ch-general`,
      status: 'waiting_me',
      unread: true,
    });
    expect(brain.turns[0]).toMatchObject({ first: true, input: { author: 'source', fromName: 'Olena' } });

    clickup.post({ id: 'r1', channel: 'ch-general', user: '8', content: 'Same for me', date: T0 + 70_000, parent: 'm1' });
    now += 60_000;
    await poll();
    await poll(); // nothing new: no duplicates
    const requests = await core.listRequests(ADA);
    expect(requests).toHaveLength(1);
    const messages = await core.listMessages(ADA, requests[0]!.id);
    expect(messages.filter(message => message.author === 'source').map(message => [message.fromName, message.text])).toEqual([
      ['Olena', 'Checkout fails for client X'],
      ['Taras', 'Same for me'],
    ]);
    expect(brain.turns).toHaveLength(2);
    expect(brain.turns[1]?.first).toBe(false);
    [request] = requests;
    expect(request?.topic).toBe('Topic of Olena');
  });

  it('a message in a closed request’s thread opens a new request continuing it', async () => {
    await connectAndWatch('ch-general');
    clickup.post({ id: 'm1', channel: 'ch-general', user: '7', content: 'Question one', date: T0 + 5000 });
    now += 60_000;
    await poll();
    const [first] = await core.listRequests(ADA);
    await service.close(ADA, first!.id);

    clickup.post({ id: 'r1', channel: 'ch-general', user: '7', content: 'One more thing', date: T0 + 70_000, parent: 'm1' });
    now += 60_000;
    await poll();
    const requests = await core.listRequests(ADA);
    expect(requests).toHaveLength(2);
    const next = requests.find(request => request.id !== first!.id)!;
    expect(next).toMatchObject({ previousRequestId: first!.id, sourceKey: first!.sourceKey, status: 'waiting_me' });
    const thread = await core.listMessages(ADA, next.id);
    expect(thread[0]).toMatchObject({ author: 'event', text: `continues:${first!.id}` });
  });

  it('only when addressed: a mention, a reply in the person’s thread, a DM — not other chatter', async () => {
    await connectAndWatch('ch-support', 'addressed');
    await source.setMode(ADA, { workspaceId: WS, channelId: 'dm-olena', mode: 'addressed' });
    now += 1000;
    await poll(); // the DM's first read
    clickup.post({ id: 'a1', channel: 'ch-support', user: '7', content: 'lunch?', date: T0 + 10_000 });
    clickup.post({ id: 'a2', channel: 'ch-support', user: '7', content: '@ada can you check the invoice', date: T0 + 11_000, tagged: ['42'] });
    clickup.post({ id: 'a3', channel: 'ch-support', user: '42', content: 'I started a thread', date: T0 + 12_000 });
    clickup.post({ id: 'a4', channel: 'ch-support', user: '8', content: 'reply to Ada', date: T0 + 13_000, parent: 'a3' });
    clickup.post({ id: 'd1', channel: 'dm-olena', user: '7', content: 'hi Ada, a quick one', date: T0 + 14_000 });
    now += 60_000;
    await poll();

    const texts = (await core.listRequests(ADA)).map(request => request.sourceKey);
    expect(texts.sort()).toEqual([`clickup:${WS}:ch-support:a2`, `clickup:${WS}:ch-support:a3`, `clickup:${WS}:dm-olena:d1`].sort());
    // The person's own root opened no request by itself; the reply to it did, with the person's line as context.
    const own = (await core.listRequests(ADA)).find(request => request.sourceKey?.endsWith(':a3'))!;
    const thread = await core.listMessages(ADA, own.id);
    expect(thread.filter(message => message.author === 'source').map(message => message.text)).toEqual(['reply to Ada']);
  });

  it('the person’s own reply joins the open request as context, without an agent turn', async () => {
    await connectAndWatch('ch-general');
    clickup.post({ id: 'm1', channel: 'ch-general', user: '7', content: 'Help please', date: T0 + 5000 });
    now += 60_000;
    await poll();
    clickup.post({ id: 'r1', channel: 'ch-general', user: '42', content: 'Looking', date: T0 + 70_000, parent: 'm1' });
    now += 60_000;
    await poll();
    const [request] = await core.listRequests(ADA);
    expect((await core.listMessages(ADA, request!.id)).filter(m => m.author === 'source').map(m => m.fromName)).toEqual(['Olena', 'ada']);
    expect(brain.turns).toHaveLength(1);
  });

  it('downloads files a message links on ClickUp’s file hosts into the request', async () => {
    const url = 'https://t9001.p.clickup-attachments.com/t9001/abc/shot.png';
    clickup.files.set(url, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]));
    await connectAndWatch('ch-general');
    clickup.post({ id: 'm1', channel: 'ch-general', user: '7', content: `See ![shot.png](${url}) and [site](https://evil.example/x.png)`, date: T0 + 5000 });
    now += 60_000;
    await poll();
    const [request] = await core.listRequests(ADA);
    const files = await core.listFiles(ADA, request!.id);
    expect(files.map(file => [file.name, file.mime])).toEqual([['shot.png', 'image/png']]);
    expect(clickup.calls.some(call => call.includes('evil.example'))).toBe(false);
    expect(brain.turns[0]?.input.files).toHaveLength(1);
  });

  it('takes files from an attachment field too (v2 task-attachment shape), each once, ClickUp hosts only', async () => {
    const shot = 'https://t9001.p.clickup-attachments.com/t9001/abc/screen.png';
    const doc = 'https://t9001.p.clickup-attachments.com/t9001/def/spec.pdf';
    clickup.files.set(shot, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]));
    clickup.files.set(doc, new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 1]));
    await connectAndWatch('ch-general');
    clickup.post({
      id: 'm1',
      channel: 'ch-general',
      user: '7',
      content: `look ![screen.png](${shot})`,
      date: T0 + 5000,
      extra: {
        attachments: [
          { id: 'a1', title: 'screen.png', url_w_host: shot, mimetype: 'image/png', extension: 'png' },
          { id: 'a2', title: 'Spec', url: doc, mimetype: 'application/pdf' },
          { id: 'a3', title: 'elsewhere', url: 'https://evil.example/x.png' },
        ],
      },
    });
    now += 60_000;
    await poll();
    const [request] = await core.listRequests(ADA);
    expect((await core.listFiles(ADA, request!.id)).map(file => [file.name, file.mime])).toEqual([
      ['screen.png', 'image/png'],
      ['Spec', 'application/pdf'],
    ]);
    expect(clickup.calls.some(call => call.includes('evil.example'))).toBe(false);
  });
});

describe('author names and attachments when the agent reads', () => {
  it('names a guest from the channel’s people, never shows a raw id, and lists the message’s files', async () => {
    await source.connect(ADA, clickup.token);
    await source.setMode(ADA, { workspaceId: WS, channelId: 'ch-support', mode: 'watch' });
    clickup.workspaces[0]!.members.push({ user: { id: 99, username: '', email: '' } });
    const support = clickup.channels.find(channel => channel.id === 'ch-support')!;
    support.members = ['7', '99', '8'];
    const url = 'https://t9001.p.clickup-attachments.com/t9001/abc/log.txt';
    clickup.post({ id: 'm1', channel: 'ch-support', user: '8', content: `log: [log.txt](${url})`, date: T0 + 5000 });
    clickup.post({ id: 'm2', channel: 'ch-support', user: '99', content: 'who am I', date: T0 + 6000 });
    const read = await source.readChannel(ADA, { ref: `clickup:${WS}:ch-support` });
    expect(read.messages).toMatchObject([
      { id: 'm1', from: 'Taras', attachments: [{ name: 'log.txt', url }] },
      { id: 'm2', from: null },
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
  it('past the hourly turn limit messages are kept but not analysed', async () => {
    build({ turnsPerHour: 1 });
    await connectAndWatch('ch-general');
    clickup.post({ id: 'm1', channel: 'ch-general', user: '7', content: 'one', date: T0 + 5000 });
    clickup.post({ id: 'm2', channel: 'ch-general', user: '7', content: 'two', date: T0 + 6000 });
    now += 60_000;
    await poll();
    expect(brain.turns).toHaveLength(1);
    const second = (await core.listRequests(ADA)).find(request => request.sourceKey?.endsWith(':m2'))!;
    expect(second.status).toBe('waiting_me');
    expect((await core.listMessages(ADA, second.id)).map(message => message.text)).toContain('not_analysed:limit');
  });

  it('a poll spends at most its call budget; the rest waits for the next poll', async () => {
    build({ callsPerPoll: 3 });
    await source.connect(ADA, clickup.token);
    for (const id of ['ch-general', 'ch-support']) await source.setMode(ADA, { workspaceId: WS, channelId: id, mode: 'watch' });
    clickup.calls.length = 0;
    await poll();
    expect(clickup.calls.length).toBeLessThanOrEqual(3);
  });

  it('backs off after failures, waits for the rate-limit reset, and stops on a rejected token', async () => {
    await connectAndWatch('ch-general');
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
  it('keeps each owner’s connection, channels and requests apart', async () => {
    await connectAndWatch('ch-general', 'watch', ADA);
    await source.connect(BOB, clickup.token);
    clickup.post({ id: 'm1', channel: 'ch-general', user: '7', content: 'for whoever watches', date: T0 + 5000 });
    now += 60_000;
    await poll(ADA);
    await poll(BOB);
    expect(await core.listRequests(ADA)).toHaveLength(1);
    expect(await core.listRequests(BOB)).toEqual([]);
    expect((await source.view(ADA_ELSEWHERE)).connected).toBe(false);
    expect((await source.view(BOB)).channels.find(channel => channel.channelId === 'ch-general')?.mode).toBe('ignore');
    await expect(source.setMode(ADA_ELSEWHERE, { workspaceId: WS, channelId: 'ch-general', mode: 'watch' })).rejects.toMatchObject({
      code: 'not_connected',
    });
  });

  it('erasing the assistant disconnects the source first and polling stops', async () => {
    await connectAndWatch('ch-general');
    await source.connect(BOB, clickup.token);
    clickup.post({ id: 'm1', channel: 'ch-general', user: '7', content: 'hello', date: T0 + 5000 });
    now += 60_000;
    await poll();
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

  it('disconnect forgets the token and modes but keeps the person’s requests', async () => {
    await connectAndWatch('ch-general');
    clickup.post({ id: 'm1', channel: 'ch-general', user: '7', content: 'hello', date: T0 + 5000 });
    now += 60_000;
    await poll();
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

describe('phase 3: channel rules and reading on demand', () => {
  it('a rule is set by the person, shown in the view; asking a Factory needs one they reach', async () => {
    await source.connect(ADA, clickup.token);
    expect((await source.view(ADA)).channels.every(channel => channel.rule === 'analyse')).toBe(true);
    await expect(
      source.setChannel(ADA, { workspaceId: WS, channelId: 'ch-support', rule: { kind: 'analyse_and_ask', factoryId: 'f-1' } }),
    ).rejects.toMatchObject({ code: 'factory_not_connected' });
    factory.connect(ADA);
    await source.setChannel(ADA, { workspaceId: WS, channelId: 'ch-support', mode: 'watch', rule: { kind: 'analyse_and_ask', factoryId: 'f-1' } });
    await source.setChannel(ADA, { workspaceId: WS, channelId: 'ch-general', rule: { kind: 'digest_only' } });
    const view = await source.view(ADA);
    expect(view.channels.map(channel => [channel.name, channel.mode, channel.rule])).toEqual([
      ['Olena', 'addressed', 'analyse'],
      ['general', 'ignore', 'digest_only'],
      ['support', 'watch', 'analyse_and_ask:f-1'],
    ]);
    // Bob's channels are untouched.
    await source.connect(BOB, clickup.token);
    expect((await source.view(BOB)).channels.every(channel => channel.rule === 'analyse')).toBe(true);
  });

  it('digest_only: a new message becomes a request without an agent turn or a spent turn', async () => {
    await connectAndWatch('ch-general');
    await source.setChannel(ADA, { workspaceId: WS, channelId: 'ch-general', rule: { kind: 'digest_only' } });
    clickup.post({ id: 'm1', channel: 'ch-general', user: '7', content: 'FYI: deploy at 5', date: T0 + 5000 });
    now += 60_000;
    await poll();
    const [request] = await core.listRequests(ADA);
    expect(request).toMatchObject({ status: 'waiting_me', fromName: 'Olena' });
    expect(brain.turns).toEqual([]);
    expect((await core.listMessages(ADA, request!.id)).map(message => message.text)).toContain('not_analysed:digest');
  });

  it('analyse_and_ask: the channel’s Factory is asked after the report', async () => {
    factory.connect(ADA);
    await connectAndWatch('ch-support');
    await source.setChannel(ADA, { workspaceId: WS, channelId: 'ch-support', rule: { kind: 'analyse_and_ask', factoryId: 'f-1' } });
    clickup.post({ id: 'm1', channel: 'ch-support', user: '7', content: 'Checkout fails for client X', date: T0 + 5000 });
    now += 60_000;
    await poll();
    expect(factory.asked).toHaveLength(1);
    expect(factory.asked[0]!.question).toContain('Checkout fails for client X');
    expect((await core.listRequests(ADA))[0]!.status).toBe('waiting_factory');
  });

  it('the agent reads only chats its owner turned on, within the read budget', async () => {
    await source.connect(ADA, clickup.token);
    await source.connect(BOB, clickup.token);
    await source.setMode(ADA, { workspaceId: WS, channelId: 'ch-support', mode: 'watch' });
    clickup.post({ id: 'm1', channel: 'ch-support', user: '7', content: 'is checkout fixed?', date: T0 + 5000 });
    clickup.post({ id: 'm2', channel: 'ch-general', user: '7', content: 'lunch?', date: T0 + 6000 });

    expect((await source.enabledChannels(ADA)).map(channel => channel.ref).sort()).toEqual([`clickup:${WS}:ch-support`, `clickup:${WS}:dm-olena`]);
    clickup.calls.length = 0;
    const read = await source.readChannel(ADA, { ref: `clickup:${WS}:ch-support` });
    expect(read.messages).toMatchObject([{ id: 'm1', from: 'Olena', text: 'is checkout fixed?' }]);
    expect(clickup.calls.length).toBeLessThanOrEqual(source.limits.callsPerRead);

    // Off for Ada, and Bob never turned support on: refused, nothing read.
    clickup.calls.length = 0;
    await expect(source.readChannel(ADA, { ref: `clickup:${WS}:ch-general` })).rejects.toMatchObject({ status: 404 });
    await expect(source.readChannel(BOB, { ref: `clickup:${WS}:ch-support` })).rejects.toMatchObject({ status: 404 });
    await expect(source.readChannel(ADA, { ref: 'clickup:other:thing:extra' })).rejects.toMatchObject({ status: 404 });
    expect(clickup.calls).toEqual([]);

    // Through the core, as the agent's tool does.
    expect((await service.listEnabledChannels(BOB)).map(channel => channel.name)).toEqual(['Olena']);
  });
});

describe('the channel list as the person’s ClickUp sidebar shows it', () => {
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
    const rows = view.channels.map(channel => ({
      name: channel.name,
      kind: channel.kind,
      location: channel.location ? `${channel.location.kind}:${channel.location.path.join(' › ')}` : null,
      inSidebar: channel.inSidebar,
    }));
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
    expect(view.channels.find(channel => channel.channelId === 'dm-olena')!.members).toEqual([
      { id: '7', name: 'Olena', avatarUrl: 'https://attachments.clickup.com/profilePictures/7_olena.jpg' },
    ]);
  });

  it('looks details up within its limit, sidebar first, keeps them, and asks again only after a day', async () => {
    sidebarFixture();
    build({ detailsPerListing: 3 });
    await source.connect(ADA, clickup.token);
    expect(lookups()).toBe(3);
    // Sidebar rows first: a followed DM is named even with the small budget; the hidden one is not yet.
    const first = await source.view(ADA);
    expect(first.channels.filter(channel => channel.kind !== 'channel' && channel.members.length > 0).every(channel => channel.inSidebar)).toBe(true);
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

  it('sets every DM to one mode at once, channels untouched', async () => {
    sidebarFixture();
    await source.connect(ADA, clickup.token);
    await source.setMode(ADA, { workspaceId: WS, channelId: 'ch-albi', mode: 'watch' });
    expect(await source.setDmModes(ADA, 'watch')).toBe(4);
    const modes = Object.fromEntries((await source.view(ADA)).channels.map(channel => [channel.channelId, channel.mode]));
    expect(modes).toMatchObject({ 'dm-olena': 'watch', 'dm-taras': 'watch', 'dm-old': 'watch', 'gdm-1': 'watch', 'ch-albi': 'watch', 'ch-bugs-1': 'ignore' });
    await expect(source.setDmModes(BOB, 'watch')).rejects.toMatchObject({ code: 'not_connected' });
  });

  it('names where a request came from with its location, and a DM by its person', async () => {
    sidebarFixture();
    await source.connect(ADA, clickup.token);
    await source.setMode(ADA, { workspaceId: WS, channelId: 'ch-bugs-2', mode: 'watch' });
    now += 1000;
    await poll();
    clickup.post({ id: 'b1', channel: 'ch-bugs-2', user: '7', content: 'crash on login', date: now + 5000 });
    now += 60_000;
    await poll();
    expect(brain.turns.at(-1)!.input.text).toContain('(#Clients › KidNation › Bugs)');
    expect((await source.enabledChannels(ADA)).map(channel => channel.name)).toEqual(
      expect.arrayContaining(['Olena', 'Olena, Taras', 'Bugs']),
    );
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
    const view = await source.connect(ADA, clickup.token);
    const dms = view.channels.filter(channel => channel.kind === 'dm');
    expect(dms.map(channel => [channel.name, channel.members.map(member => member.name), channel.detailsError])).toEqual([
      ['Olena', ['Olena'], null],
      ['Taras', ['Taras'], null],
    ]);
  });

  it('takes members that come back as bare ids too', async () => {
    liveFixture();
    clickup.memberShape = 'ids';
    const view = await source.connect(ADA, clickup.token);
    expect(view.channels.filter(channel => channel.kind === 'dm').map(channel => channel.name)).toEqual(['Olena', 'Taras']);
  });

  it('is_follower is only a filter: the full list is asked without it, and …/followers finds the sidebar the filter missed', async () => {
    liveFixture();
    const view = await source.connect(ADA, clickup.token);
    const listing = clickup.calls.filter(call => call.includes('/chat/channels?'));
    expect(listing.some(call => call.includes('is_follower=true'))).toBe(true);
    expect(listing.some(call => !call.includes('is_follower'))).toBe(true);
    expect(listing.some(call => call.includes('is_follower=false'))).toBe(false);
    const sidebar = Object.fromEntries(view.channels.map(channel => [channel.name, channel.inSidebar]));
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
    const view = await source.view(ADA);
    expect(view.channels.find(channel => channel.channelId === 'ch-syncta')?.inSidebar).toBe(true);
    expect(view.channels.find(channel => channel.channelId === 'dm-olena')?.name).toBe('Olena');
  });

  it('a lookup ClickUp refuses shows its code on the row and is tried again after a while', async () => {
    liveFixture();
    clickup.failPaths = [{ path: /\/members$/, status: 403 }];
    let view = await source.connect(ADA, clickup.token);
    const olena = () => view.channels.find(channel => channel.channelId === 'dm-olena')!;
    expect(olena().detailsError).toEqual({ what: 'members', code: '403' });
    expect(olena().members).toEqual([]);
    clickup.failPaths = [];
    now += 60_000;
    await poll();
    view = await source.view(ADA);
    expect(olena().detailsError).toEqual({ what: 'members', code: '403' });
    now += source.limits.detailsRetryMs;
    await poll();
    view = await source.view(ADA);
    expect(olena()).toMatchObject({ name: 'Olena', detailsError: null });
  });

  it('a members list that comes back empty is a visible failure, not a silent blank', async () => {
    liveFixture();
    clickup.channels.find(channel => channel.id === 'dm-taras')!.members = [];
    const view = await source.connect(ADA, clickup.token);
    expect(view.channels.find(channel => channel.channelId === 'dm-taras')!.detailsError).toEqual({ what: 'members', code: 'empty' });
  });

  it('«fetch failed» is tried again with backoff; past the tries the cause code is what the person sees', async () => {
    await connectAndWatch('ch-general');
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
      await source.setMode(ADA, { workspaceId: WS, channelId: 'dm-olena', mode: 'watch' });
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
    const messages = diagnostics.lastRead!.calls.find(call => call.endpoint === 'v3.chat.messages');
    expect(messages).toMatchObject({ status: 200, count: 1, itemKinds: ['object'] });
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
