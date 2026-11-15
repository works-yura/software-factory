import { LibSQLFactoryStorage } from '@mastra/libsql';
import { beforeEach, describe, expect, it } from 'vitest';

import { splitTopic } from './agent.ts';
import type { SourceMessage } from './ports.ts';
import { AssistantService } from './service.ts';
import { AssistantStorage } from './storage.ts';
import { FakeBrain, FakeFactory, FakeMemory, fakeModels, MemoryBlobStore } from './testing.ts';
import type { AssistantOwner } from './types.ts';

const ADA: AssistantOwner = { orgId: 'org-a', userId: 'ada' };
const ADA_ELSEWHERE: AssistantOwner = { orgId: 'org-b', userId: 'ada' };
const BOB: AssistantOwner = { orgId: 'org-a', userId: 'bob' };

let storage: AssistantStorage;
let brain: FakeBrain;
let pending: Array<() => Promise<void>>;
let service: AssistantService;

function message(overrides: Partial<SourceMessage> = {}): SourceMessage {
  return {
    platform: 'clickup',
    sourceKey: 'clickup:9001:ch:root-1',
    messageKey: 'clickup:9001:root-1',
    text: 'Checkout fails',
    fromName: 'Olena',
    sourceUrl: 'https://app.clickup.com/9001/chat/r/ch',
    files: [],
    fromMe: false,
    analyse: true,
    ...overrides,
  };
}

/** Runs scheduled turns only when asked, so a test can look while the agent is still answering. */
async function runTurns() {
  while (pending.length) await pending.shift()!();
}

beforeEach(async () => {
  const backend = new LibSQLFactoryStorage({ id: 'assistant-ingest-test', url: ':memory:' });
  storage = backend.registerDomain(new AssistantStorage());
  await backend.init();
  brain = new FakeBrain();
  brain.topic = () => 'Checkout is broken for a client';
  pending = [];
  const factory = new FakeFactory();
  service = new AssistantService({
    storage,
    blobs: new MemoryBlobStore(),
    brain,
    memory: new FakeMemory(),
    models: fakeModels,
    factory,
    grant: factory,
    audit: async () => undefined,
    blobReferencedElsewhere: async () => false,
    schedule: task => {
      pending.push(task);
    },
  });
});

describe('taking in source messages', () => {
  it('is idempotent by the message’s own id, also when two reads race', async () => {
    const [a, b] = await Promise.all([service.ingestSourceMessage(ADA, message()), service.ingestSourceMessage(ADA, message())]);
    expect([a.outcome, b.outcome].sort()).toEqual(['created', 'duplicate']);
    expect((await service.ingestSourceMessage(ADA, message())).outcome).toBe('duplicate');
    await runTurns();
    expect(await storage.listRequests(ADA)).toHaveLength(1);
    expect(brain.turns).toHaveLength(1);
  });

  it('binds by thread: follow-ups join the open request, and wait for the agent’s current turn', async () => {
    const created = await service.ingestSourceMessage(ADA, message());
    const followed = await service.ingestSourceMessage(ADA, message({ messageKey: 'clickup:9001:reply-1', text: 'Any news?' }));
    expect(followed).toMatchObject({ outcome: 'appended', request: { id: created.request!.id, analysing: true } });
    await runTurns();
    expect(brain.turns.map(turn => [turn.first, turn.input.text])).toEqual([
      [true, 'Checkout fails'],
      [false, 'Any news?'],
    ]);
    const request = await storage.getRequest(ADA, created.request!.id);
    expect(request).toMatchObject({ analysing: false, status: 'waiting_me', topic: 'Checkout is broken for a client' });
  });

  it('a closed request’s thread opens a new request that continues it', async () => {
    const first = await service.ingestSourceMessage(ADA, message());
    await runTurns();
    await service.close(ADA, first.request!.id);
    const next = await service.ingestSourceMessage(ADA, message({ messageKey: 'clickup:9001:reply-2', text: 'Again' }));
    expect(next.outcome).toBe('reopened');
    expect(next.request).toMatchObject({ previousRequestId: first.request!.id, sourceKey: 'clickup:9001:ch:root-1' });
    expect(await service.hasOpenSourceRequest(ADA, 'clickup:9001:ch:root-1')).toBe(true);
  });

  it('the person’s own message never starts a request', async () => {
    expect((await service.ingestSourceMessage(ADA, message({ fromMe: true }))).outcome).toBe('skipped');
    expect(await storage.listRequests(ADA)).toEqual([]);
  });

  it('keeps owners apart: the same thread is a separate request per person and organization', async () => {
    for (const owner of [ADA, BOB, ADA_ELSEWHERE]) {
      expect((await service.ingestSourceMessage(owner, message())).outcome).toBe('created');
    }
    await runTurns();
    for (const owner of [ADA, BOB, ADA_ELSEWHERE]) expect(await storage.listRequests(owner)).toHaveLength(1);
    expect(await service.hasOpenSourceRequest(BOB, 'clickup:9001:ch:other')).toBe(false);
  });

  it('retention erases a source request with its message keys', async () => {
    const created = await service.ingestSourceMessage(ADA, message());
    await runTurns();
    await service.close(ADA, created.request!.id);
    expect(await storage.hasSourceMessage(ADA, 'clickup:9001:root-1')).toBe(true);
    await storage.deleteRequest(ADA, created.request!.id);
    expect(await storage.hasSourceMessage(ADA, 'clickup:9001:root-1')).toBe(false);
  });
});

describe('the agent’s topic line', () => {
  it('splits a first line `Topic: …` from the report, and leaves other answers alone', () => {
    expect(splitTopic('Topic: Invoice for March\n\nOlena asks for the invoice.')).toEqual({
      topic: 'Invoice for March',
      text: 'Olena asks for the invoice.',
    });
    expect(splitTopic('**Topic:** Login bug\nDetails')).toEqual({ topic: 'Login bug', text: 'Details' });
    expect(splitTopic('Just a report')).toEqual({ text: 'Just a report' });
  });
});
