/**
 * Picking up after a server restart (ADR-0051): a turn in flight and the wait for a Factory's answer
 * live in memory only. A restart is simulated by a first service whose scheduled work never runs
 * (the process died), then a second one on the same storage that runs `resumeAfterRestart`.
 */
import { LibSQLFactoryStorage } from '@mastra/libsql';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RESUME_NOTE, turnMessage } from './agent.ts';
import { startAssistantResume } from './resume.ts';
import { AssistantService } from './service.ts';
import type { AssistantLimits } from './service.ts';
import { AssistantStorage } from './storage.ts';
import { FakeBrain, FakeFactory, FakeMemory, fakeModels } from './testing.ts';
import type { AssistantModels } from './ports.ts';
import type { AssistantOwner } from './types.ts';

const ADA: AssistantOwner = { orgId: 'org-a', userId: 'ada' };
const BOB: AssistantOwner = { orgId: 'org-a', userId: 'bob' };

let storage: AssistantStorage;
let brain: FakeBrain;
let factory: FakeFactory;
let now: Date;
let pending: Array<Promise<void>>;
let sleeps: number[];

/** A server process: `dead` drops every scheduled task, as a process that stops mid-work. */
function boot(options: { dead?: boolean; limits?: Partial<AssistantLimits>; models?: AssistantModels } = {}) {
  return new AssistantService({
    storage,
    brain,
    memory: new FakeMemory(),
    models: options.models ?? fakeModels,
    factory,
    grant: factory,
    audit: async () => undefined,
    blobReferencedElsewhere: async () => false,
    now: () => now,
    schedule: task => {
      if (!options.dead) pending.push(task());
    },
    sleep: async ms => {
      sleeps.push(ms);
      now = new Date(now.getTime() + ms);
    },
    limits: { answerPollIntervalMs: 20_000, answerPollTimeoutMs: 15 * 60_000, ...options.limits },
  });
}

async function settle() {
  while (pending.length) await pending.shift();
}

const events = async (owner: AssistantOwner, id: string) =>
  (await storage.listMessages(owner, id)).filter(message => message.author === 'event').map(message => message.text);

beforeEach(async () => {
  const backend = new LibSQLFactoryStorage({ id: 'assistant-resume-test', url: ':memory:' });
  storage = backend.registerDomain(new AssistantStorage());
  await backend.init();
  brain = new FakeBrain();
  factory = new FakeFactory();
  factory.connect(ADA);
  now = new Date('2026-11-15T10:00:00Z');
  pending = [];
  sleeps = [];
});

describe('a turn the restart cut short', () => {
  it('runs again once, with the restart note and what it was answering, and never twice', async () => {
    const request = await boot({ dead: true }).createRequest(ADA, { text: 'Client asks for the invoice' });
    expect((await storage.getRequest(ADA, request.id))!.analysing).toBe(true);
    expect(brain.turns).toHaveLength(0);

    now = new Date(now.getTime() + 60_000);
    const second = boot();
    expect(await second.resumeAfterRestart('boot-2')).toEqual([{ owner: ADA, requestId: request.id, outcome: 'turn' }]);
    // The same start again (a second call, a racing tick): nothing runs twice.
    expect(await second.resumeAfterRestart('boot-2')).toEqual([{ owner: ADA, requestId: request.id, outcome: 'already' }]);
    await settle();

    expect(brain.turns).toHaveLength(1);
    const turn = brain.turns[0]!;
    expect(turn.input.author).toBe('resumed');
    expect(turn.input.text).toContain('[person] Client asks for the invoice');
    const message = turnMessage(turn).content[0] as { text: string };
    expect(message.text.startsWith(RESUME_NOTE)).toBe(true);
    expect(message.text).toContain('Сервер перезапускався під час твоєї роботи над цим зверненням. Перевір, на чому зупинився, і продовж.');

    const thread = await storage.listMessages(ADA, request.id);
    expect(thread.map(entry => entry.author)).toEqual(['person', 'event', 'agent']);
    expect(thread[1]!.text).toBe('resumed:boot-2');
    expect(await storage.getRequest(ADA, request.id)).toMatchObject({ analysing: false, status: 'waiting_me', lastError: null });

    // A third start finds nothing left to pick up.
    expect(await boot().resumeAfterRestart('boot-3')).toEqual([]);
    await settle();
    expect(brain.turns).toHaveLength(1);
  });

  it('is left for the person when the resume itself was cut short by another restart', async () => {
    const request = await boot({ dead: true }).createRequest(ADA, { text: 'Hello' });
    expect(await boot({ dead: true }).resumeAfterRestart('boot-2')).toEqual([{ owner: ADA, requestId: request.id, outcome: 'turn' }]);

    expect(await boot().resumeAfterRestart('boot-3')).toEqual([{ owner: ADA, requestId: request.id, outcome: 'left' }]);
    await settle();
    expect(brain.turns).toHaveLength(0);
    expect(await events(ADA, request.id)).toEqual(['resumed:boot-2', 'not_analysed:restart']);
    expect(await storage.getRequest(ADA, request.id)).toMatchObject({ analysing: false, unread: true });
    // «Analyse» (retry) runs it as usual.
    const service = boot();
    await service.retry(ADA, request.id);
    await settle();
    expect(brain.turns).toHaveLength(1);
  });

  it('only clears the mark when the agent had already answered', async () => {
    const first = boot();
    const request = await first.createRequest(ADA, { text: 'Hello' });
    await settle();
    await storage.updateRequest(ADA, request.id, { analysing: true }, now);

    expect(await boot().resumeAfterRestart('boot-2')).toEqual([{ owner: ADA, requestId: request.id, outcome: 'settled' }]);
    expect(brain.turns).toHaveLength(1);
    expect(await storage.getRequest(ADA, request.id)).toMatchObject({ analysing: false });
    expect(await events(ADA, request.id)).toEqual([]);
  });

  it('skips a person with no model to run, with the usual failure', async () => {
    const request = await boot({ dead: true }).createRequest(ADA, { text: 'Hello' });
    const noModels: AssistantModels = {
      async catalog() {
        return { groups: [], default: null, defaultReason: 'No model credentials are connected.' };
      },
    };
    expect(await boot({ models: noModels }).resumeAfterRestart('boot-2')).toEqual([{ owner: ADA, requestId: request.id, outcome: 'no_model' }]);
    await settle();
    expect(brain.turns).toHaveLength(0);
    expect(await storage.getRequest(ADA, request.id)).toMatchObject({
      analysing: false,
      lastError: { kind: 'no_model', detail: 'No model credentials are connected.' },
    });
    expect(await events(ADA, request.id)).toEqual([]);
  });

  it('runs at most the per-person number of turns, newest first, and leaves old requests alone', async () => {
    const dead = boot({ dead: true });
    const old = await dead.createRequest(ADA, { text: 'Two days ago' });
    now = new Date(now.getTime() + 2 * 24 * 60 * 60_000);
    const older = await dead.createRequest(ADA, { text: 'First' });
    now = new Date(now.getTime() + 1000);
    const newer = await dead.createRequest(ADA, { text: 'Second' });
    const bobs = await dead.createRequest(BOB, { text: 'Bob’s' });

    const outcomes = await boot({ limits: { resumeTurnsPerOwner: 1 } }).resumeAfterRestart('boot-2');
    await settle();
    expect(outcomes).toEqual(
      expect.arrayContaining([
        { owner: ADA, requestId: newer.id, outcome: 'turn' },
        { owner: ADA, requestId: older.id, outcome: 'left' },
        { owner: BOB, requestId: bobs.id, outcome: 'turn' },
      ]),
    );
    expect(outcomes.some(entry => entry.requestId === old.id)).toBe(false);
    expect(brain.turns.map(turn => turn.request.id).sort()).toEqual([newer.id, bobs.id].sort());
  });
});

describe('the wait for a Factory’s answer the restart cut short', () => {
  async function asked() {
    const first = boot();
    const request = await first.createRequest(ADA, { text: 'Is the API down?' });
    await settle();
    const dead = boot({ dead: true });
    await dead.askFactory(ADA, request.id, { factoryId: 'f-1', question: 'Is the API down?' });
    return request;
  }

  it('polls again for what is left of the original wait, and the answer comes in as usual', async () => {
    const request = await asked();
    now = new Date(now.getTime() + 5 * 60_000);
    factory.answer = 'It was a deploy; back up now.';

    expect(await boot().resumeAfterRestart('boot-2')).toEqual([{ owner: ADA, requestId: request.id, outcome: 'polling' }]);
    await settle();
    // One check found the answer; the turn concluded from it.
    expect(sleeps).toEqual([20_000]);
    const thread = await storage.listMessages(ADA, request.id);
    expect(thread.map(entry => entry.author)).toEqual(['person', 'agent', 'event', 'event', 'factory', 'agent']);
    expect(thread[3]!.text).toBe('resumed:boot-2');
    expect(brain.turns.at(-1)!.input.author).toBe('factory');
  });

  it('stops at the original deadline, not a new one', async () => {
    const request = await asked();
    now = new Date(now.getTime() + 14 * 60_000);
    expect(await boot().resumeAfterRestart('boot-2')).toEqual([{ owner: ADA, requestId: request.id, outcome: 'polling' }]);
    await settle();
    // One minute left: three checks, then the usual timeout line.
    expect(sleeps).toEqual([20_000, 20_000, 20_000]);
    expect(await events(ADA, request.id)).toEqual(['asked:Shop\nIs the API down?', 'resumed:boot-2', 'answer_timeout']);
    expect((await storage.getRequest(ADA, request.id))!.status).toBe('waiting_factory');
  });

  it('lets the agent check once when the wait ran out while the server was down', async () => {
    const request = await asked();
    now = new Date(now.getTime() + 40 * 60_000);
    const turns = brain.turns.length;

    const second = boot();
    expect(await second.resumeAfterRestart('boot-2')).toEqual([{ owner: ADA, requestId: request.id, outcome: 'turn' }]);
    expect(await second.resumeAfterRestart('boot-2')).toEqual([{ owner: ADA, requestId: request.id, outcome: 'already' }]);
    await settle();
    expect(sleeps).toEqual([]);
    expect(brain.turns).toHaveLength(turns + 1);
    const turn = brain.turns.at(-1)!;
    expect(turn.input.author).toBe('resumed');
    expect(turn.input.text).toContain('sessionId side-1');
    expect(turn.input.text).toContain('factory_session_status');
  });

  it('after a resumed check was itself cut short, leaves «Check answer» to the person', async () => {
    const request = await asked();
    now = new Date(now.getTime() + 40 * 60_000);
    await boot({ dead: true }).resumeAfterRestart('boot-2');

    expect(await boot().resumeAfterRestart('boot-3')).toEqual([{ owner: ADA, requestId: request.id, outcome: 'timeout' }]);
    await settle();
    expect(brain.turns.at(-1)!.input.author).not.toBe('resumed');
    expect(await storage.getRequest(ADA, request.id)).toMatchObject({ analysing: false, status: 'waiting_factory' });
    expect((await events(ADA, request.id)).slice(-2)).toEqual(['resumed:boot-2', 'answer_timeout']);
  });

  it('does nothing once the answer is in or the wait timed out before the restart', async () => {
    const request = await asked();
    await storage.addMessage(ADA, { requestId: request.id, author: 'event', text: 'answer_timeout', now });
    expect(await boot().resumeAfterRestart('boot-2')).toEqual([]);
  });
});

describe('the job', () => {
  it('runs once per server start, a while after the routes are up', async () => {
    vi.useFakeTimers();
    try {
      const service = { resumeAfterRestart: vi.fn(async () => [{ owner: ADA, requestId: 'r', outcome: 'turn' as const }]) };
      const job = startAssistantResume(service, { afterMs: 1000 });
      expect(service.resumeAfterRestart).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1000);
      expect(await job.run()).toBe(1);
      expect(service.resumeAfterRestart).toHaveBeenCalledTimes(1);
      expect(service.resumeAfterRestart).toHaveBeenCalledWith(job.bootId);
      job.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
