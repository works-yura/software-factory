import { AssistantService, AssistantStorage } from '@factory/assistant-core';
import type { AssistantOwner } from '@factory/assistant-core';
import { FakeBrain, FakeFactory, FakeMemory, fakeModels, MemoryBlobStore, testCipher } from '@factory/assistant-core/testing';
import { LibSQLFactoryStorage } from '@mastra/libsql';
import { beforeEach, describe, expect, it } from 'vitest';

import { ClickUpChatClient, fileLinks, isClickUpFileUrl } from './client.ts';
import { FakeClickUp } from './fake-clickup.ts';
import { startClickUpPolling } from './scheduler.ts';
import type { ClickUpPollLimits } from './source.ts';
import { ClickUpChatSource } from './source.ts';
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

function build(limits: Partial<ClickUpPollLimits> = {}) {
  source = new ClickUpChatSource({
    storage,
    cipher: testCipher,
    ingest: { ingestSourceMessage: (o, m) => service.ingestSourceMessage(o, m), hasOpenSourceRequest: (o, k) => service.hasOpenSourceRequest(o, k) },
    client: options => new ClickUpChatClient({ ...options, fetch: clickup.fetch }),
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
      { id: 'x1', content: 'hi', date: T0, userId: '7', channelId: 'ch-general', parentMessageId: null, repliesCount: 1 },
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
