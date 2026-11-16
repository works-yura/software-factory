import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LibSQLFactoryStorage } from '@mastra/libsql';
import { beforeEach, describe, expect, it } from 'vitest';

import type { AssistantAuditEvent } from './ports.ts';
import { AssistantError } from './errors.ts';
import { AssistantService, deriveTopic } from './service.ts';
import { AssistantStorage } from './storage.ts';
import { AssistantTurnError } from './turn-failure.ts';
import { FakeBrain, FakeFactory, FakeMemory, fakeModels, LocalTestWorkspaceHost, MemoryBlobStore } from './testing.ts';
import type { AssistantOwner } from './types.ts';

const ADA: AssistantOwner = { orgId: 'org-a', userId: 'ada' };
const ADA_ELSEWHERE: AssistantOwner = { orgId: 'org-b', userId: 'ada' };
const BOB: AssistantOwner = { orgId: 'org-a', userId: 'bob' };

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const OTHER = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9]);

let storage: AssistantStorage;
let blobs: MemoryBlobStore;
let brain: FakeBrain;
let memory: FakeMemory;
let factory: FakeFactory;
let audits: AssistantAuditEvent[];
let elsewhere: Set<string>;
let pending: Array<Promise<void>>;
let now: Date;
let log: string[];
let service: AssistantService;

function build(extra: Partial<ConstructorParameters<typeof AssistantService>[0]> = {}) {
  return new AssistantService({
    storage,
    blobs,
    brain,
    memory,
    models: fakeModels,
    factory,
    grant: factory,
    audit: async event => {
      log.push('audit');
      audits.push(event);
    },
    blobReferencedElsewhere: async sha => elsewhere.has(sha),
    now: () => now,
    schedule: task => {
      pending.push(task());
    },
    // The phase-1 tests check the answer by hand; the phase-3 tests turn the background checks on.
    limits: { answerPollTimeoutMs: 0 },
    sleep: async () => undefined,
    ...extra,
  });
}

async function settle() {
  while (pending.length) await pending.shift();
}

beforeEach(async () => {
  const backend = new LibSQLFactoryStorage({ id: 'assistant-test', url: ':memory:' });
  storage = backend.registerDomain(new AssistantStorage());
  await backend.init();
  blobs = new MemoryBlobStore();
  brain = new FakeBrain();
  memory = new FakeMemory();
  factory = new FakeFactory();
  audits = [];
  elsewhere = new Set();
  pending = [];
  now = new Date('2026-11-15T10:00:00Z');
  log = [];
  service = build();
});

describe('a request the person brings', () => {
  it('is new while the agent looks, then waits for the person with the agent’s report', async () => {
    const created = await service.createRequest(ADA, {
      text: 'Client says checkout fails\nsee screenshot',
      fromName: 'Olena',
      sourceUrl: 'https://app.clickup.com/t/123',
      files: [{ name: 'shot.png', declaredMime: 'image/png', bytes: PNG }],
    });
    expect(created).toMatchObject({ status: 'new', analysing: true, topic: 'Client says checkout fails', fromName: 'Olena' });

    await settle();
    const view = await service.openRequest(ADA, created.id);
    expect(view.request).toMatchObject({ status: 'waiting_me', analysing: false, lastError: null });
    expect(view.messages.map(message => message.author)).toEqual(['person', 'agent']);
    expect(view.files).toHaveLength(1);
    expect(view.files[0]).toMatchObject({ name: 'shot.png', mime: 'image/png', size: PNG.length });
    // The model saw the screenshot as an image, with the request's owner and topic.
    expect(brain.turns[0]!.input.files).toEqual([{ name: 'shot.png', mime: 'image/png', bytes: PNG }]);
    expect(brain.turns[0]!.owner).toEqual(ADA);
  });

  it('is unread once the agent wrote, and read once opened', async () => {
    const created = await service.createRequest(ADA, { text: 'hello' });
    await settle();
    expect((await service.listRequests(ADA))[0]!.unread).toBe(true);
    await service.openRequest(ADA, created.id);
    expect((await service.listRequests(ADA))[0]!.unread).toBe(false);
  });

  it('shows why when the agent fails (no model in the organization), and stays new', async () => {
    brain.answer = () => {
      throw new Error('Your organization has no model connected.');
    };
    const created = await service.createRequest(ADA, { text: 'help' });
    await settle();
    const view = await service.openRequest(ADA, created.id);
    expect(view.request).toMatchObject({
      status: 'new',
      analysing: false,
      lastError: { kind: 'unknown', detail: 'Your organization has no model connected.' },
    });
  });

  it('records a provider failure with its kind and model, and runs the same turn again on retry', async () => {
    brain.answer = () => {
      throw new AssistantTurnError('xai/grok-4.5', Object.assign(new Error('Too Many Requests'), { statusCode: 429 }));
    };
    const created = await service.createRequest(ADA, {
      text: 'checkout fails',
      files: [{ name: 'shot.png', declaredMime: 'image/png', bytes: PNG }],
    });
    await settle();
    let view = await service.openRequest(ADA, created.id);
    expect(view.request.lastError).toMatchObject({ kind: 'rate_limit', modelId: 'xai/grok-4.5', status: 429 });
    expect(view.request.lastError!.detail).toContain('Too Many Requests');

    brain.answer = turn => `seen: ${turn.input.text}`;
    const retried = await service.retry(ADA, created.id);
    expect(retried).toMatchObject({ analysing: true, lastError: null });
    await settle();
    view = await service.openRequest(ADA, created.id);
    expect(view.request).toMatchObject({ analysing: false, lastError: null, status: 'waiting_me' });
    expect(view.messages.map(message => message.author)).toEqual(['person', 'agent']);
    const turn = brain.turns.at(-1)!;
    expect(turn.input).toMatchObject({ author: 'person', text: 'checkout fails' });
    expect(turn.input.files).toEqual([{ name: 'shot.png', mime: 'image/png', bytes: PNG }]);

    // Everything is answered now: nothing to run again.
    await expect(service.retry(ADA, created.id)).rejects.toMatchObject({ code: 'nothing_to_retry', status: 409 });
    await expect(service.retry(BOB, created.id)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('refuses an empty request, a bad link, and files without a store', async () => {
    await expect(service.createRequest(ADA, { text: '  ' })).rejects.toMatchObject({ code: 'empty', status: 400 });
    await expect(service.createRequest(ADA, { text: 'x', sourceUrl: 'javascript:alert(1)' })).rejects.toMatchObject({
      code: 'invalid_source_url',
    });
    const storeless = build({ blobs: undefined });
    await expect(
      storeless.createRequest(ADA, { text: 'x', files: [{ name: 'a.png', declaredMime: null, bytes: PNG }] }),
    ).rejects.toMatchObject({ code: 'files_unavailable', status: 503 });
    expect(await service.listRequests(ADA)).toEqual([]);
  });

  it('takes the person’s replies until it is closed', async () => {
    const created = await service.createRequest(ADA, { text: 'first' });
    await settle();
    await service.postMessage(ADA, created.id, { text: 'and also this' });
    await settle();
    expect((await service.openRequest(ADA, created.id)).messages.map(m => m.author)).toEqual(['person', 'agent', 'person', 'agent']);

    const closed = await service.close(ADA, created.id);
    expect(closed).toMatchObject({ status: 'closed' });
    expect(closed.closedAt).toEqual(now);
    await expect(service.postMessage(ADA, created.id, { text: 'more' })).rejects.toMatchObject({ code: 'request_closed' });
  });

  it('takes the person’s own topic and status, closing and reopening', async () => {
    const created = await service.createRequest(ADA, { text: 'first' });
    await settle();
    const renamed = await service.updateRequest(ADA, created.id, { topic: '  Checkout   for Olena ' });
    expect(renamed.topic).toBe('Checkout for Olena');
    await expect(service.updateRequest(ADA, created.id, { topic: ' ' })).rejects.toMatchObject({ code: 'invalid_topic', status: 400 });

    const closed = await service.updateRequest(ADA, created.id, { status: 'closed' });
    expect(closed).toMatchObject({ status: 'closed', closedAt: now, unread: false });
    const reopened = await service.updateRequest(ADA, created.id, { status: 'waiting_me' });
    expect(reopened).toMatchObject({ status: 'waiting_me', closedAt: null });
    await expect(service.updateRequest(BOB, created.id, { status: 'closed' })).rejects.toMatchObject({ status: 404 });
  });

  it('takes its topic from the first line, or the first file', () => {
    expect(deriveTopic('\n  Line one \nLine two', [])).toBe('Line one');
    expect(deriveTopic('', [{ name: 'shot.png' }])).toBe('shot.png');
    expect(deriveTopic('x'.repeat(300), [])).toHaveLength(120);
  });
});

describe('owners', () => {
  it('never see another person’s requests, notes or files, nor their own in another organization', async () => {
    const created = await service.createRequest(ADA, { text: 'secret', files: [{ name: 'a.png', declaredMime: null, bytes: PNG }] });
    await settle();
    const note = await service.createNote(ADA, { text: 'remember' });
    const fileId = (await service.openRequest(ADA, created.id)).files[0]!.id;

    for (const stranger of [BOB, ADA_ELSEWHERE]) {
      expect(await service.listRequests(stranger)).toEqual([]);
      expect(await service.listNotes(stranger)).toEqual([]);
      await expect(service.openRequest(stranger, created.id)).rejects.toMatchObject({ status: 404 });
      await expect(service.postMessage(stranger, created.id, { text: 'x' })).rejects.toMatchObject({ status: 404 });
      await expect(service.close(stranger, created.id)).rejects.toMatchObject({ status: 404 });
      await expect(service.openFile(stranger, fileId)).rejects.toMatchObject({ status: 404 });
      await expect(service.updateNote(stranger, note.id, 'x')).rejects.toMatchObject({ status: 404 });
      await expect(service.deleteNote(stranger, note.id)).rejects.toMatchObject({ status: 404 });
      await expect(service.createNote(stranger, { text: 'x', requestId: created.id })).rejects.toMatchObject({ status: 404 });
    }
    expect((await service.openRequest(ADA, created.id)).request.topic).toBe('secret');
  });

  it('refuses an owner with an empty half before touching anything', async () => {
    await expect(service.listRequests({ orgId: '', userId: 'ada' })).rejects.toThrow(/both an organization id and a user id/);
    await expect(service.clear({ orgId: 'org-a', userId: ' ' }, { reason: 'cleared_by_person', actorId: 'x' })).rejects.toThrow();
  });
});

describe('Factory', () => {
  it('needs the person’s access first', async () => {
    const created = await service.createRequest(ADA, { text: 'q' });
    await expect(service.askFactory(ADA, created.id, { factoryId: 'f-1' })).rejects.toMatchObject({ code: 'factory_not_connected', status: 409 });
  });

  it('asks: waits for Factory, then the answer and the agent’s conclusion come back to the person', async () => {
    factory.connect(ADA);
    const created = await service.createRequest(ADA, { text: 'Why is checkout failing?', fromName: 'Olena' });
    await settle();
    const asked = await service.askFactory(ADA, created.id, { factoryId: 'f-1' });
    expect(asked).toMatchObject({ status: 'waiting_factory', factory: { factoryId: 'f-1', factoryName: 'Shop', sessionId: 'side-1' } });
    expect(factory.asked[0]!.question).toContain('Why is checkout failing?');
    expect(factory.asked[0]!.question).toContain('From: Olena');

    expect((await service.checkFactoryAnswer(ADA, created.id)).answered).toBe(false);
    factory.answer = 'The payment key expired.';
    const checked = await service.checkFactoryAnswer(ADA, created.id);
    expect(checked.answered).toBe(true);
    await settle();
    const view = await service.openRequest(ADA, created.id);
    expect(view.request.status).toBe('waiting_me');
    expect(view.messages.map(m => m.author)).toEqual(['person', 'agent', 'event', 'factory', 'agent']);
    expect(brain.turns.at(-1)!.input).toMatchObject({ author: 'factory', text: 'The payment key expired.' });
  });

  it('refuses a Factory the person cannot reach', async () => {
    factory.connect(ADA);
    const created = await service.createRequest(ADA, { text: 'q' });
    await expect(service.askFactory(ADA, created.id, { factoryId: 'other' })).rejects.toMatchObject({ code: 'factory_not_found' });
  });

  it('hands over: a card with the request’s files, linked in the topic line, once', async () => {
    factory.connect(ADA);
    const created = await service.createRequest(ADA, { text: 'Fix the banner', files: [{ name: 'a.png', declaredMime: null, bytes: PNG }] });
    await settle();
    const handed = await service.handOver(ADA, created.id, { factoryId: 'f-1' });
    expect(handed).toMatchObject({ status: 'waiting_factory', factory: { workItemId: 'card-1', factoryName: 'Shop' } });
    expect(factory.handed[0]).toMatchObject({ title: 'Fix the banner', files: ['a.png'] });
    expect(factory.handed[0]!.description).toContain('Fix the banner');
    await expect(service.handOver(ADA, created.id, { factoryId: 'f-1' })).rejects.toMatchObject({ code: 'already_handed_over' });
  });

  it('puts the person’s hand-over note first in the card and in the thread', async () => {
    factory.connect(ADA);
    const created = await service.createRequest(ADA, { text: 'Fix the banner' });
    await settle();
    await service.handOver(ADA, created.id, { factoryId: 'f-1', note: 'Only on mobile' });
    expect(factory.handed[0]!.description.startsWith('Only on mobile\n\nFix the banner')).toBe(true);
    const view = await service.openRequest(ADA, created.id);
    expect(view.messages.find(m => m.author === 'event')!.text).toBe('handed:Shop\nOnly on mobile');
  });

  it('turns a Factory failure into its answer to the person', async () => {
    factory.connect(ADA);
    factory.ask = async () => {
      throw new Error('Your role cannot use the Factory MCP endpoint.');
    };
    const created = await service.createRequest(ADA, { text: 'q' });
    await expect(service.askFactory(ADA, created.id, { factoryId: 'f-1' })).rejects.toMatchObject({
      code: 'factory_failed',
      status: 502,
      message: 'Factory answered: Your role cannot use the Factory MCP endpoint.',
    });
  });
});

describe('settings', () => {
  it('keeps 30 days by default and only the organization’s models', async () => {
    expect(await service.getSettings(ADA)).toMatchObject({ modelId: null, retentionDays: 30, skills: [] });
    await expect(service.patchSettings(ADA, { retentionDays: 0 })).rejects.toMatchObject({ code: 'invalid_retention' });
    await expect(service.patchSettings(ADA, { modelId: 'openai/gpt-x' })).rejects.toMatchObject({ code: 'unknown_model' });
    expect(await service.patchSettings(ADA, { modelId: 'anthropic/claude-sonnet-4-5', retentionDays: 7 })).toMatchObject({
      modelId: 'anthropic/claude-sonnet-4-5',
      retentionDays: 7,
    });
    expect(await service.getSettings(BOB)).toMatchObject({ modelId: null, retentionDays: 30, skills: [] });
    // The agent runs on the chosen model.
    const created = await service.createRequest(ADA, { text: 'q' });
    await settle();
    expect(brain.turns.at(-1)!.modelId).toBe('anthropic/claude-sonnet-4-5');
    expect(created.id).toBeTruthy();
  });
});

describe('erasing an assistant', () => {
  it('goes in the ADR’s order and leaves one audit entry without content', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-ws-'));
    const workspace = new LocalTestWorkspaceHost(root);
    const ordered = build({ workspace });
    // Another owner's workspace stays.
    await (await workspace.open(BOB)).filesystem!.writeFile('keep.txt', 'bob');

    const created = await ordered.createRequest(ADA, { text: 'private words', files: [{ name: 'a.png', declaredMime: null, bytes: PNG }] });
    await settle();
    await ordered.createNote(ADA, { text: 'note' });
    await ordered.patchSettings(ADA, { retentionDays: 5 });
    const sha = (await ordered.openRequest(ADA, created.id)).files[0]!.id;
    expect(sha).toBeTruthy();

    // Record what is left at each step.
    const rowsLeft = async () => (await storage.listRequests(ADA)).length + (await storage.listNotes(ADA)).length;
    factory.revoke = async () => {
      log.push(`revoke rows=${await rowsLeft()}`);
    };
    memory.forget = async () => {
      log.push(`memory rows=${await rowsLeft()}`);
    };
    const originalDelete = blobs.delete.bind(blobs);
    blobs.delete = async key => {
      log.push(`bytes rows=${await rowsLeft()} files=${(await storage.listFiles(ADA)).length}`);
      return originalDelete(key);
    };
    const folder = workspace.folder(ADA);
    // The request's file is in its workspace folder, written by the turn.
    expect(await stat(join(folder, 'requests', created.id, 'a.png'))).toBeTruthy();
    await writeFile(join(folder, 'scratch.txt'), 'x');
    const erase = workspace.erase.bind(workspace);
    workspace.erase = async owner => {
      log.push(`workspace rows=${await rowsLeft()} files=${(await storage.listFiles(ADA)).length}`);
      return erase(owner);
    };

    const cleared = await ordered.clear(ADA, { reason: 'member_removed', actorId: 'admin-1' });

    expect(cleared).toEqual({ requests: 1, files: 1 });
    expect(log).toEqual(['revoke rows=2', 'memory rows=2', 'bytes rows=0 files=0', 'workspace rows=0 files=0', 'audit']);
    await expect(stat(folder)).rejects.toThrow();
    expect(await stat(join(workspace.folder(BOB), 'keep.txt'))).toBeTruthy();
    await workspace.close();
    await rm(root, { recursive: true, force: true });
    expect(audits).toEqual([{ orgId: 'org-a', userId: 'ada', actorId: 'admin-1', reason: 'member_removed', counts: { requests: 1, files: 1 } }]);
    expect(JSON.stringify(audits)).not.toContain('private words');
    expect(await storage.getSettings(ADA)).toMatchObject({ modelId: null, retentionDays: 30, skills: [] });
    expect(blobs.blobs.size).toBe(0);
  });

  it('keeps bytes another owner or a Factory attachment still names', async () => {
    const mine = await service.createRequest(ADA, { text: 'a', files: [{ name: 'a.png', declaredMime: null, bytes: PNG }] });
    await service.createRequest(BOB, { text: 'b', files: [{ name: 'b.png', declaredMime: null, bytes: PNG }] });
    await service.createRequest(ADA, { text: 'c', files: [{ name: 'c.png', declaredMime: null, bytes: OTHER }] });
    await settle();
    const [shared] = (await service.openRequest(ADA, mine.id)).files;
    const other = [...blobs.blobs.keys()].find(key => key !== shared!.sha256)!;
    elsewhere.add(other);

    await service.clear(ADA, { reason: 'cleared_by_person', actorId: 'ada' });

    // Bob's request still names PNG; a Factory attachment names OTHER.
    expect(blobs.deleted).toEqual([]);
    expect(blobs.blobs.has(shared!.sha256)).toBe(true);
    expect((await service.listRequests(BOB))).toHaveLength(1);

    await service.clear(BOB, { reason: 'cleared_by_person', actorId: 'bob' });
    expect(blobs.deleted).toEqual([shared!.sha256]);
  });

  it('erases one organization’s assistant on removal, and every organization’s for a deleted account', async () => {
    await service.createRequest(ADA, { text: 'a' });
    await service.createRequest(ADA_ELSEWHERE, { text: 'b' });
    await service.createRequest(BOB, { text: 'c' });
    await settle();

    await service.clear(ADA, { reason: 'member_removed', actorId: 'admin' });
    expect(await service.listRequests(ADA)).toEqual([]);
    expect(await service.listRequests(ADA_ELSEWHERE)).toHaveLength(1);

    expect(await service.clearUser('ada', { reason: 'account_deleted', actorId: 'ada' })).toBe(1);
    expect(await service.listRequests(ADA_ELSEWHERE)).toEqual([]);
    expect(await service.listRequests(BOB)).toHaveLength(1);
    expect(memory.calls).toEqual(['forget:org-a:ada', 'forget:org-b:ada']);
  });

  it('sweeps closed requests past their owner’s retention, with their memory thread and files', async () => {
    const old = await service.createRequest(ADA, { text: 'old', files: [{ name: 'a.png', declaredMime: null, bytes: PNG }] });
    const recent = await service.createRequest(ADA, { text: 'recent' });
    const open = await service.createRequest(ADA, { text: 'open' });
    const bobs = await service.createRequest(BOB, { text: 'bob old' });
    await settle();
    await service.patchSettings(BOB, { retentionDays: 60 });
    await service.close(ADA, old.id);
    await service.close(BOB, bobs.id);
    now = new Date(now.getTime() + 20 * 86_400_000);
    await service.close(ADA, recent.id);
    now = new Date(now.getTime() + 15 * 86_400_000);

    expect(await service.sweepRetention()).toEqual({ requests: 1, files: 1 });

    expect((await service.listRequests(ADA)).map(r => r.id).sort()).toEqual([open.id, recent.id].sort());
    expect(await service.listRequests(BOB)).toHaveLength(1);
    expect(memory.calls).toEqual([`forgetThread:org-a:ada:${old.id}`]);
    expect(blobs.blobs.size).toBe(0);
  });
});

describe('deleting a request', () => {
  it('removes it at once, open or closed, with its memory thread and files; only the owner’s', async () => {
    const mine = await service.createRequest(ADA, { text: 'mine', files: [{ name: 'a.png', declaredMime: null, bytes: PNG }] });
    const kept = await service.createRequest(ADA, { text: 'kept' });
    await settle();

    await expect(service.deleteRequest(BOB, mine.id)).rejects.toMatchObject({ code: 'not_found' });
    await service.deleteRequest(ADA, mine.id);

    expect((await service.listRequests(ADA)).map(r => r.id)).toEqual([kept.id]);
    await expect(service.openRequest(ADA, mine.id)).rejects.toMatchObject({ code: 'not_found' });
    expect(memory.calls).toContain(`forgetThread:org-a:ada:${mine.id}`);
    expect(blobs.blobs.size).toBe(0);
  });
});

describe('errors', () => {
  it('are AssistantErrors with a code and a status', async () => {
    const error = await service.openRequest(ADA, 'missing').catch(caught => caught);
    expect(error).toBeInstanceOf(AssistantError);
    expect(error).toMatchObject({ code: 'not_found', status: 404 });
  });
});
