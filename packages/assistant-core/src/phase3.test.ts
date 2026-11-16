/**
 * Phase 3 of «Помічник»: the agent's tools are its owner's only; asking a Factory and handing over
 * are only proposed by the agent and run on the person's Confirm (never silently); the person's
 * instructions and skills reach the agent; digests on the person's schedule; the routes the settings
 * page uses. (Channel rules were retired with the tag trigger, ADR-0051 amendment 2026-11-16.)
 */
import { can } from '@factory/access';
import { enforceRouteAccess } from '@factory/http';
import type { RouteAuth } from '@factory/http';
import { LibSQLFactoryStorage } from '@mastra/libsql';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';

import { ASSISTANT_GUARD, assistantInstructions } from './instructions.ts';
import { nextDigestAt } from './digest.ts';
import { FactoryAccess } from './factory-access.ts';
import type { AssistantSkills, AssistantSource, BrainTurn, SourceChannelInfo, SourceMessage } from './ports.ts';
import { buildAssistantRoutes } from './routes.ts';
import { AssistantService } from './service.ts';
import { AssistantStorage } from './storage.ts';
import { FakeBrain, FakeFactory, FakeMemory, fakeModels, MemoryBlobStore, testCipher } from './testing.ts';
import type { AssistantOwner } from './types.ts';

const ADA: AssistantOwner = { orgId: 'org-a', userId: 'ada' };
const ADA_ELSEWHERE: AssistantOwner = { orgId: 'org-b', userId: 'ada' };
const BOB: AssistantOwner = { orgId: 'org-a', userId: 'bob' };

let storage: AssistantStorage;
let brain: FakeBrain;
let factory: FakeFactory;
let pending: Array<Promise<void>>;
let now: Date;
let service: AssistantService;
let source: FakeSource;

const SKILLS: AssistantSkills = {
  async list() {
    return [
      { name: 'factory-triage', description: 'Sort an incoming issue.' },
      { name: 'product-brief', description: 'Write a product brief.' },
    ];
  },
  async read(_owner, name) {
    return name === 'factory-triage' ? { name, description: 'Sort an incoming issue.', instructions: 'Step 1: read it.' } : null;
  },
};

/** A source whose channels belong to one owner each: what another owner asks for is refused. */
class FakeSource implements AssistantSource {
  readonly platform = 'clickup';
  readonly channels = new Map<string, SourceChannelInfo[]>();
  readonly reads: string[] = [];
  async disconnect() {}
  async organizationsOf() {
    return [];
  }
  async taggedChannels(owner: AssistantOwner) {
    return this.channels.get(`${owner.orgId}:${owner.userId}`) ?? [];
  }
  async readChannel(owner: AssistantOwner, input: { ref: string }) {
    const channel = (await this.taggedChannels(owner)).find(candidate => candidate.ref === input.ref);
    if (!channel) throw new (await import('./errors.ts')).AssistantError('not_found', 'No such chat.', 404);
    this.reads.push(`${owner.userId}:${input.ref}`);
    return { channel, messages: [{ id: 'm1', from: 'Olena', text: 'is checkout fixed?', at: now.toISOString(), replies: 0, threadId: null }] };
  }
}

function build(extra: Partial<ConstructorParameters<typeof AssistantService>[0]> = {}) {
  return new AssistantService({
    storage,
    blobs: new MemoryBlobStore(),
    brain,
    memory: new FakeMemory(),
    models: fakeModels,
    factory,
    grant: factory,
    sources: [source],
    skills: SKILLS,
    audit: async () => undefined,
    blobReferencedElsewhere: async () => false,
    now: () => now,
    schedule: task => {
      pending.push(task());
    },
    sleep: async () => undefined,
    limits: { answerPollIntervalMs: 20, answerPollTimeoutMs: 60 },
    ...extra,
  });
}

async function settle() {
  while (pending.length) await pending.shift();
}

beforeEach(async () => {
  const backend = new LibSQLFactoryStorage({ id: 'assistant-phase3', url: ':memory:' });
  storage = backend.registerDomain(new AssistantStorage());
  await backend.init();
  brain = new FakeBrain();
  factory = new FakeFactory();
  source = new FakeSource();
  pending = [];
  now = new Date('2026-11-15T10:20:00Z');
  service = build();
});

/** Runs one tool of the turn the way the model would. */
type ToolLike = { execute: (input: unknown, context: unknown) => Promise<unknown> };
function tool(turn: BrainTurn, name: string): ToolLike {
  const found = (turn.tools as Record<string, ToolLike> | undefined)?.[name];
  if (!found) throw new Error(`no tool ${name}`);
  return found;
}
const run = (turn: BrainTurn, name: string, input: unknown = {}) => tool(turn, name).execute(input, {}) as Promise<Record<string, unknown>>;

async function requestOf(owner: AssistantOwner, text: string) {
  const created = await service.createRequest(owner, { text });
  await settle();
  return created;
}

describe('the agent’s tools are its owner’s only', () => {
  it('reads and searches the owner’s requests and notes; another person’s (or org’s) are not found', async () => {
    const adas = await requestOf(ADA, 'Checkout fails for Olena');
    await requestOf(ADA_ELSEWHERE, 'Checkout in the other org');
    const bobs = await requestOf(BOB, 'Bob’s own checkout question');
    await service.createNote(ADA, { text: 'Olena prefers Ukrainian' });

    const turn = brain.turns.find(candidate => candidate.owner.userId === 'bob')!;
    const found = await run(turn, 'assistant_search_requests', { query: 'checkout' });
    expect((found.requests as Array<{ id: string }>).map(request => request.id)).toEqual([bobs.id]);
    expect(await run(turn, 'assistant_read_request', { requestId: adas.id })).toEqual({ error: 'Request not found.' });
    expect(await run(turn, 'assistant_list_notes')).toEqual({ notes: [] });

    const adaTurn = brain.turns.find(candidate => candidate.owner.userId === 'ada' && candidate.owner.orgId === 'org-a')!;
    const read = await run(adaTurn, 'assistant_read_request', { requestId: adas.id });
    expect(read).toMatchObject({ request: { id: adas.id, topic: 'Checkout fails for Olena' } });
    // Reading for the agent does not mark the request read for the person.
    expect((await storage.getRequest(ADA, adas.id))!.unread).toBe(true);
  });

  it('writes a note as the agent, to its owner only', async () => {
    const created = await requestOf(BOB, 'remember this');
    const turn = brain.turns[0]!;
    await run(turn, 'assistant_create_note', { text: 'Bob wants a call on Friday', aboutThisRequest: true });
    expect(await service.listNotes(ADA)).toEqual([]);
    expect(await service.listNotes(BOB)).toMatchObject([{ text: 'Bob wants a call on Friday', author: 'agent', requestId: created.id }]);
  });

  it('lists and reads only the chats its owner tagged it in', async () => {
    source.channels.set('org-a:ada', [{ ref: 'clickup:9001:ch-support', name: 'support', kind: 'channel' }]);
    await requestOf(BOB, 'what is new in support?');
    const turn = brain.turns[0]!;
    expect(await run(turn, 'source_list_channels')).toEqual({ channels: [] });
    expect(await run(turn, 'source_read_channel', { channel: 'clickup:9001:ch-support' })).toEqual({ error: 'No such chat.' });
    expect(source.reads).toEqual([]);
  });

  it('reaches Factory as its owner, read-only tools only', async () => {
    factory.connect(ADA);
    await requestOf(ADA, 'is the checkout card moving?');
    const turn = brain.turns[0]!;
    expect(await run(turn, 'factory_find_work_items', { factoryId: 'f-1', query: 'checkout', requestedByMe: true })).toMatchObject({
      items: [{ id: 'card-9' }],
    });
    expect(factory.reads).toEqual([
      { owner: 'org-a:ada', factoryId: 'f-1', tool: 'factory_list_work_items', args: { query: 'checkout', requestedBy: 'me', limit: 10 } },
    ]);
    await expect(service.factoryRead(ADA, { factoryId: 'f-1', tool: 'factory_create_work_item' as never, args: {} })).rejects.toMatchObject({
      code: 'not_read_only',
    });
    // Bob never allowed Factory access: his tools get nothing, and Ada's grant is not his.
    await requestOf(BOB, 'and mine?');
    const bobs = brain.turns.at(-1)!;
    expect(await run(bobs, 'factory_list_factories')).toEqual({ connected: false, factories: [] });
    expect(await run(bobs, 'factory_inspect_work_item', { factoryId: 'f-1', workItem: '#1' })).toMatchObject({ error: expect.stringContaining('Allow the assistant') });
  });

  it('caps the agent’s steps per turn', async () => {
    service = build({ limits: { stepsPerTurn: 3, answerPollTimeoutMs: 0 } });
    await requestOf(ADA, 'hi');
    expect(brain.turns[0]!.maxSteps).toBe(3);
  });
});

describe('Factory actions wait for the person’s confirmation', () => {
  it('a proposed question runs only on Confirm, once; the answer comes back on its own', async () => {
    factory.connect(ADA);
    brain.answer = async turn => {
      if (turn.input.author === 'person') {
        const proposed = await run(turn, 'factory_propose_ask', { factoryId: 'f-1', question: 'Why does checkout fail?', reason: 'Shop owns checkout.' });
        expect(proposed).toMatchObject({ proposed: true });
        // One proposal per answer.
        expect(await run(turn, 'factory_propose_hand_over', { factoryId: 'f-1' })).toMatchObject({ error: expect.any(String) });
        return 'I propose asking Shop.';
      }
      return `conclusion: ${turn.input.text}`;
    };
    const created = await requestOf(ADA, 'Checkout fails');
    expect(factory.asked).toEqual([]);
    const proposed = (await storage.getRequest(ADA, created.id))!;
    expect(proposed.pendingAction).toMatchObject({ kind: 'ask', factoryId: 'f-1', factoryName: 'Shop', question: 'Why does checkout fail?', proposedBy: 'agent' });
    expect(proposed.status).toBe('waiting_me');

    // Another person (or a stale id) cannot run it.
    await expect(service.confirmAction(BOB, created.id, proposed.pendingAction!.id)).rejects.toMatchObject({ status: 404 });
    await expect(service.confirmAction(ADA, created.id, 'not-it')).rejects.toMatchObject({ code: 'no_pending_action' });
    expect(factory.asked).toEqual([]);

    factory.answer = 'The payment key expired.';
    const confirmed = await service.confirmAction(ADA, created.id, proposed.pendingAction!.id);
    expect(confirmed).toMatchObject({ status: 'waiting_factory', pendingAction: null, factory: { sessionId: 'side-1' } });
    await expect(service.confirmAction(ADA, created.id, proposed.pendingAction!.id)).rejects.toMatchObject({ code: 'no_pending_action' });
    await settle();
    expect(factory.asked).toHaveLength(1);
    const view = await service.openRequest(ADA, created.id);
    expect(view.request.status).toBe('waiting_me');
    expect(view.messages.map(message => message.author === 'event' ? message.text.split('\n')[0] : message.author)).toEqual([
      'person',
      'proposed:ask:Shop',
      'agent',
      'asked:Shop',
      'confirmed:ask',
      'factory',
      'agent',
    ]);
  });

  it('a cancelled hand-over creates nothing', async () => {
    factory.connect(ADA);
    brain.answer = async turn => {
      await run(turn, 'factory_propose_hand_over', { factoryId: 'f-1', note: 'Please fix the banner' });
      return 'I propose handing it to Shop.';
    };
    const created = await requestOf(ADA, 'Banner is broken');
    const action = (await storage.getRequest(ADA, created.id))!.pendingAction!;
    expect(action).toMatchObject({ kind: 'hand_over', note: 'Please fix the banner' });
    const cancelled = await service.cancelAction(ADA, created.id, action.id);
    expect(cancelled.pendingAction).toBeNull();
    expect(factory.handed).toEqual([]);
    await expect(service.confirmAction(ADA, created.id, action.id)).rejects.toMatchObject({ code: 'no_pending_action' });
    const messages = await storage.listMessages(ADA, created.id);
    expect(messages.some(message => message.text === 'cancelled:hand_over')).toBe(true);
  });

  it('a failed run puts the proposal back for another try', async () => {
    factory.connect(ADA);
    const created = await requestOf(ADA, 'Banner is broken');
    const action = await service.proposeAction(ADA, created.id, { kind: 'hand_over', factoryId: 'f-1', proposedBy: 'agent' });
    factory.handOver = async () => {
      throw new Error('Viewer cannot create cards');
    };
    await expect(service.confirmAction(ADA, created.id, action.id)).rejects.toMatchObject({ code: 'factory_failed' });
    expect((await storage.getRequest(ADA, created.id))!.pendingAction?.id).toBe(action.id);
  });

  it('a proposal needs a Factory the person reaches', async () => {
    const created = await requestOf(ADA, 'q');
    await expect(service.proposeAction(ADA, created.id, { kind: 'ask', factoryId: 'f-1', question: 'q', proposedBy: 'agent' })).rejects.toMatchObject({
      code: 'factory_not_connected',
    });
  });

  it('stops waiting for the answer after the timeout; the person checks by hand then', async () => {
    factory.connect(ADA);
    const created = await requestOf(ADA, 'Checkout fails');
    await service.askFactory(ADA, created.id, { factoryId: 'f-1', question: 'why?' });
    await settle();
    const messages = await storage.listMessages(ADA, created.id);
    expect(messages.at(-1)!.text).toBe('answer_timeout');
    expect((await storage.getRequest(ADA, created.id))!.status).toBe('waiting_factory');
  });
});

describe('instructions and skills', () => {
  it('the picked skills reach the agent, after the base document and before the guard', async () => {
    await expect(service.patchSettings(ADA, { skills: ['no-such-skill'] })).rejects.toMatchObject({ code: 'unknown_skill' });
    await service.saveBehavior(ADA, 'Always answer in Ukrainian.');
    const settings = await service.patchSettings(ADA, { skills: ['factory-triage', 'factory-triage'] });
    expect(settings).toMatchObject({ skills: ['factory-triage'] });

    await requestOf(ADA, 'hi');
    const turn = brain.turns[0]!;
    expect(turn.systemPrompt).toContain('Always answer in Ukrainian.');
    expect(turn.systemPrompt).toContain('factory-triage: Sort an incoming issue.');
    expect(turn.skills).toEqual([{ name: 'factory-triage', description: 'Sort an incoming issue.' }]);
    expect(await run(turn, 'assistant_read_skill', { name: 'factory-triage' })).toEqual({ name: 'factory-triage', instructions: 'Step 1: read it.' });
    // A skill the person did not pick is not readable, even through the service.
    expect(await service.readSkill(ADA, 'product-brief')).toBeNull();
    // Bob's turn has neither.
    await requestOf(BOB, 'hi');
    expect(brain.turns.at(-1)!.systemPrompt).not.toContain('Always answer in Ukrainian.');
    expect((brain.turns.at(-1)!.tools as Record<string, unknown>).assistant_read_skill).toBeUndefined();

    const text = assistantInstructions({ base: 'BASE', skills: [{ name: 'factory-triage', description: 'Sort.' }] });
    expect(text.indexOf('BASE')).toBeLessThan(text.indexOf('factory-triage'));
    expect(text.endsWith(ASSISTANT_GUARD)).toBe(true);
  });
});

function sourceMessage(n: number): SourceMessage {
  return {
    platform: 'clickup',
    sourceKey: `clickup:9001:ch-support:root-${n}`,
    messageKey: `clickup:9001:m-${n}`,
    text: `Checkout broke again #${n}`,
    fromName: 'Olena',
    sourceUrl: 'https://app.clickup.com/9001/chat/r/ch-support',
    context: [],
    contextKind: 'chat',
    files: [],
    analyse: true,
    where: '#support',
  };
}

describe('digests', () => {
  it('computes the next digest: the next full hour, or the hour in the person’s zone', () => {
    const at = new Date('2026-11-15T10:20:00Z');
    expect(nextDigestAt(at, { frequency: 'off', hour: 9, timeZone: 'UTC' })).toBeNull();
    expect(nextDigestAt(at, { frequency: 'hourly', hour: 9, timeZone: 'UTC' })!.toISOString()).toBe('2026-11-15T11:00:00.000Z');
    expect(nextDigestAt(at, { frequency: 'daily', hour: 9, timeZone: 'UTC' })!.toISOString()).toBe('2026-11-16T09:00:00.000Z');
    // Kyiv is UTC+2 in November: 13:00 there is 11:00 UTC, still today.
    expect(nextDigestAt(at, { frequency: 'daily', hour: 13, timeZone: 'Europe/Kyiv' })!.toISOString()).toBe('2026-11-15T11:00:00.000Z');
  });

  it('is off by default, refuses a bad schedule, and writes one request when due', async () => {
    expect((await service.getSettings(ADA)).digest).toEqual({ frequency: 'off', hour: 9, timeZone: 'UTC' });
    await expect(service.patchSettings(ADA, { digest: { frequency: 'daily', timeZone: 'Mars/Base' } })).rejects.toMatchObject({ code: 'invalid_digest' });
    await expect(service.patchSettings(ADA, { digest: { frequency: 'weekly' as never } })).rejects.toMatchObject({ code: 'invalid_digest' });

    await service.ingestSourceMessage(ADA, sourceMessage(1));
    await requestOf(BOB, 'Bob’s request stays out of Ada’s digest');
    await service.patchSettings(ADA, { digest: { frequency: 'hourly' } });
    expect((await service.digestSchedule(ADA)).nextAt!.toISOString()).toBe('2026-11-15T11:00:00.000Z');

    expect(await service.runDueDigests()).toBe(0);
    now = new Date('2026-11-15T11:00:30Z');
    const turnsBefore = brain.turns.length;
    expect(await service.runDueDigests()).toBe(1);
    await settle();
    const digest = (await service.listRequests(ADA)).find(request => request.source === 'digest')!;
    expect(digest).toMatchObject({ status: 'waiting_me', unread: true });
    const turn = brain.turns.slice(turnsBefore).find(candidate => candidate.input.author === 'digest')!;
    expect(turn.owner).toEqual(ADA);
    expect(turn.input.text).toContain('Checkout broke again #1');
    expect(turn.input.text).not.toContain('Bob');
    expect((await service.digestSchedule(ADA)).nextAt!.toISOString()).toBe('2026-11-15T12:00:00.000Z');
    // Not due again until then; Bob has none.
    expect(await service.runDueDigests()).toBe(0);
    expect((await service.listRequests(BOB)).some(request => request.source === 'digest')).toBe(false);
  });

  it('writes no request when nothing is open, and turning it off stops it', async () => {
    await service.patchSettings(ADA, { digest: { frequency: 'hourly' } });
    now = new Date('2026-11-15T11:00:30Z');
    expect(await service.runDueDigests()).toBe(1);
    expect(await service.listRequests(ADA)).toEqual([]);
    await service.patchSettings(ADA, { digest: { frequency: 'off' } });
    expect((await service.digestSchedule(ADA)).nextAt).toBeNull();
    now = new Date('2026-11-16T11:00:30Z');
    expect(await service.runDueDigests()).toBe(0);
  });
});

describe('routes the settings page and the thread use', () => {
  const auth: RouteAuth = {
    enabled: () => true,
    ensureUser: async () => undefined,
    tenant: (c: Context) => {
      const userId = c.req.header('x-user');
      return userId ? { userId, orgId: 'org-a', role: 'member' } : undefined;
    },
    can: async (_c: Context, permission) => can('member', permission),
  };
  let app: Hono;
  const send = (path: string, method: string, user: string, body?: unknown) =>
    app.request(`http://localhost${path}`, {
      method,
      headers: { 'x-user': user, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  beforeEach(() => {
    const access = new FactoryAccess({ storage, cipher: testCipher, publicOrigin: 'http://localhost', authServer: async () => new Response('{}') });
    app = new Hono();
    for (const route of enforceRouteAccess(buildAssistantRoutes({ auth, service, access, models: fakeModels }), auth)) {
      app.on([route.method], route.path, c => (route as unknown as { handler: (c: Context) => Promise<Response> }).handler(c));
    }
  });

  it('GET /skills, GET/PUT /settings with skills and the digest', async () => {
    expect(await (await send('/web/assistant/skills', 'GET', 'ada')).json()).toEqual({
      skills: (await SKILLS.list(ADA)).map(skill => ({ ...skill, origin: 'factory', overridden: false, enabled: false })),
    });
    expect((await send('/web/assistant/settings', 'PUT', 'ada', { instructions: 'Be short.' })).status).toBe(400);
    const put = await send('/web/assistant/settings', 'PUT', 'ada', {
      skills: ['factory-triage'],
      digest: { frequency: 'daily', hour: 13, timeZone: 'Europe/Kyiv' },
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({
      settings: {
        modelId: null,
        retentionDays: 30,
        skills: ['factory-triage'],
        digest: { frequency: 'daily', hour: 13, timeZone: 'Europe/Kyiv' },
      },
      digestSchedule: { lastAt: null, nextAt: '2026-11-15T11:00:00.000Z' },
    });
    expect((await send('/web/assistant/settings', 'PUT', 'ada', { skills: 'factory-triage' })).status).toBe(400);
    expect((await send('/web/assistant/settings', 'PUT', 'ada', { skills: ['nope'] })).status).toBe(400);
    const bob = (await (await send('/web/assistant/settings', 'GET', 'bob')).json()) as { settings: { skills: string[] } };
    expect(bob.settings.skills).toEqual([]);
  });

  it('POST …/actions/:actionId/confirm and …/cancel, the caller’s own only', async () => {
    factory.connect(ADA);
    const created = await requestOf(ADA, 'Banner is broken');
    const action = await service.proposeAction(ADA, created.id, { kind: 'hand_over', factoryId: 'f-1', proposedBy: 'agent' });
    const opened = (await (await send(`/web/assistant/requests/${created.id}`, 'GET', 'ada')).json()) as { request: { pendingAction: { id: string; kind: string } } };
    expect(opened.request.pendingAction).toMatchObject({ id: action.id, kind: 'hand_over', factoryName: 'Shop' });

    expect((await send(`/web/assistant/requests/${created.id}/actions/${action.id}/confirm`, 'POST', 'bob')).status).toBe(404);
    expect(factory.handed).toEqual([]);
    const confirmed = await send(`/web/assistant/requests/${created.id}/actions/${action.id}/confirm`, 'POST', 'ada');
    expect(confirmed.status).toBe(200);
    expect(await confirmed.json()).toMatchObject({ request: { status: 'waiting_factory', pendingAction: null, factory: { workItemId: 'card-1' } } });
    expect(factory.handed).toHaveLength(1);
    expect((await send(`/web/assistant/requests/${created.id}/actions/${action.id}/cancel`, 'POST', 'ada')).status).toBe(409);
  });
});
