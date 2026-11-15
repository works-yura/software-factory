/**
 * What drives the assistant, in the open (ADR-0051, settings page): the base instructions as one
 * document the person edits (default shipped as base-instructions.md, the phase-3 «own
 * instructions» merged in once), skills overridden or written for the assistant only, the whole
 * effective system prompt and tool list, what drove each reply, and the model check.
 */
import { readFileSync } from 'node:fs';

import { can } from '@factory/access';
import { enforceRouteAccess } from '@factory/http';
import type { RouteAuth } from '@factory/http';
import { LibSQLFactoryStorage } from '@mastra/libsql';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';

import { BASE_INSTRUCTIONS_MARKDOWN } from './base-instructions.ts';
import { FactoryAccess } from './factory-access.ts';
import { ASSISTANT_AGENT_INSTRUCTIONS, ASSISTANT_GUARD, instructionsVersion } from './instructions.ts';
import type { AssistantSkills, BrainTurn } from './ports.ts';
import { buildAssistantRoutes } from './routes.ts';
import { AssistantService, providerOf } from './service.ts';
import { AssistantStorage } from './storage.ts';
import { FakeBrain, FakeFactory, FakeMemory, fakeModels, MemoryBlobStore, testCipher } from './testing.ts';
import { recordToolCalls } from './tools.ts';
import type { AssistantOwner, ToolCallRecord } from './types.ts';

const ADA: AssistantOwner = { orgId: 'org-a', userId: 'ada' };
const ADA_ELSEWHERE: AssistantOwner = { orgId: 'org-b', userId: 'ada' };
const BOB: AssistantOwner = { orgId: 'org-a', userId: 'bob' };

const SKILLS: AssistantSkills = {
  async list() {
    return [
      { name: 'factory-triage', description: 'Sort an incoming issue.' },
      { name: 'product-brief', description: 'Write a product brief.' },
    ];
  },
  async read(_owner, name) {
    if (name === 'factory-triage') return { name, description: 'Sort an incoming issue.', instructions: 'Step 1: read it.' };
    if (name === 'product-brief') return { name, description: 'Write a product brief.', instructions: 'Who, what, why.' };
    return null;
  },
};

let storage: AssistantStorage;
let brain: FakeBrain;
let factory: FakeFactory;
let pending: Array<Promise<void>>;
let service: AssistantService;

beforeEach(async () => {
  const backend = new LibSQLFactoryStorage({ id: 'assistant-transparency', url: ':memory:' });
  storage = backend.registerDomain(new AssistantStorage());
  await backend.init();
  brain = new FakeBrain();
  factory = new FakeFactory();
  pending = [];
  service = new AssistantService({
    storage,
    blobs: new MemoryBlobStore(),
    brain,
    memory: new FakeMemory(),
    models: fakeModels,
    factory,
    grant: factory,
    skills: SKILLS,
    audit: async () => undefined,
    blobReferencedElsewhere: async () => false,
    schedule: task => {
      pending.push(task());
    },
    sleep: async () => undefined,
    limits: { answerPollTimeoutMs: 0, modelChecksPerHour: 3 },
  });
});

async function settle() {
  while (pending.length) await pending.shift();
}

async function requestOf(owner: AssistantOwner, text: string) {
  const created = await service.createRequest(owner, { text });
  await settle();
  return created;
}

type ToolLike = { execute: (input: unknown, context: unknown) => Promise<unknown> };
const run = (turn: BrainTurn, name: string, input: unknown = {}) =>
  (turn.tools as Record<string, ToolLike>)[name]!.execute(input, {}) as Promise<Record<string, unknown>>;

describe('the base instructions', () => {
  it('ship as base-instructions.md, and the module the server bundles is generated from it', () => {
    const md = readFileSync(new URL('./base-instructions.md', import.meta.url), 'utf8');
    expect(BASE_INSTRUCTIONS_MARKDOWN).toBe(md);
    expect(ASSISTANT_AGENT_INSTRUCTIONS).toBe(md.trim());
  });

  it('are the default until the person saves their version; «Restore default» goes back; the guard stays', async () => {
    const initial = await service.getBehavior(ADA);
    expect(initial).toMatchObject({ document: ASSISTANT_AGENT_INSTRUCTIONS, defaultDocument: ASSISTANT_AGENT_INSTRUCTIONS, customized: false, updatedAt: null });

    const saved = await service.saveBehavior(ADA, `${ASSISTANT_AGENT_INSTRUCTIONS}\n\n- Always answer in Ukrainian.`);
    expect(saved.customized).toBe(true);
    expect(saved.updatedAt).toBeInstanceOf(Date);
    expect(saved.version).not.toBe(initial.version);
    // Another person, or the same person in another organization, still has the default.
    expect((await service.getBehavior(BOB)).customized).toBe(false);
    expect((await service.getBehavior(ADA_ELSEWHERE)).customized).toBe(false);

    await requestOf(ADA, 'hi');
    const prompt = brain.turns[0]!.systemPrompt!;
    expect(prompt).toContain('Always answer in Ukrainian.');
    expect(prompt.endsWith(ASSISTANT_GUARD)).toBe(true);

    await expect(service.saveBehavior(ADA, '   ')).rejects.toMatchObject({ code: 'empty' });
    await expect(service.saveBehavior(ADA, 'x'.repeat(20_001))).rejects.toMatchObject({ code: 'instructions_too_long' });
    // Saving the default text itself is «not customized».
    expect((await service.saveBehavior(ADA, ASSISTANT_AGENT_INSTRUCTIONS)).customized).toBe(false);
    await service.saveBehavior(ADA, 'Mine.');
    const reset = await service.resetBehavior(ADA);
    expect(reset).toMatchObject({ document: ASSISTANT_AGENT_INSTRUCTIONS, customized: false, updatedAt: null, version: initial.version });
  });

  it('merges the phase-3 «own instructions» into the person’s document once', async () => {
    await storage.patchSettings(ADA, { modelId: null });
    // A row as phase 3 left it: the old column set, no document.
    await (storage as unknown as { ops: { updateAtomic: (t: string, w: object, f: () => object) => Promise<unknown> } }).ops.updateAtomic(
      'assistant_settings',
      { owner_org_id: 'org-a', owner_user_id: 'ada' },
      () => ({ instructions: 'Be short.' }),
    );
    const merged = await service.getBehavior(ADA);
    expect(merged.customized).toBe(true);
    expect(merged.document.startsWith(ASSISTANT_AGENT_INSTRUCTIONS)).toBe(true);
    expect(merged.document).toContain('## My instructions\n\nBe short.');
    expect((await storage.getBehavior(ADA)).legacyInstructions).toBe('');
    // Read again: merged only once.
    expect((await service.getBehavior(ADA)).document.match(/Be short\./g)).toHaveLength(1);
  });
});

describe('skills for the assistant only', () => {
  it('overrides a catalogue skill without touching the original, and reverts it', async () => {
    await service.patchSettings(ADA, { skills: ['factory-triage'] });
    const saved = await service.saveSkill(ADA, 'factory-triage', { description: 'Sort it my way.', instructions: 'Step 1: ask Olena.' });
    expect(saved).toMatchObject({
      origin: 'factory',
      overridden: true,
      enabled: true,
      instructions: 'Step 1: ask Olena.',
      original: { description: 'Sort an incoming issue.', instructions: 'Step 1: read it.' },
    });
    expect((await service.skillsCatalogue(ADA)).find(skill => skill.name === 'factory-triage')).toMatchObject({ description: 'Sort it my way.', overridden: true });
    // The agent loads the override; Bob still gets the original.
    expect(await service.readSkill(ADA, 'factory-triage')).toMatchObject({ instructions: 'Step 1: ask Olena.' });
    await service.patchSettings(BOB, { skills: ['factory-triage'] });
    expect(await service.readSkill(BOB, 'factory-triage')).toMatchObject({ instructions: 'Step 1: read it.' });
    expect(await SKILLS.read(ADA, 'factory-triage')).toMatchObject({ instructions: 'Step 1: read it.' });

    await requestOf(ADA, 'hi');
    expect(brain.turns[0]!.systemPrompt).toContain('factory-triage: Sort it my way.');

    expect(await service.deleteSkill(ADA, 'factory-triage')).toEqual({ reverted: true, deleted: false });
    expect(await service.getSkill(ADA, 'factory-triage')).toMatchObject({ overridden: false, instructions: 'Step 1: read it.', enabled: true });
    await expect(service.deleteSkill(ADA, 'factory-triage')).rejects.toMatchObject({ code: 'skill_not_found' });
  });

  it('creates, picks and deletes a skill of the person’s own; names and texts are checked', async () => {
    await expect(service.createSkill(ADA, { name: 'Bad Name', description: 'x', instructions: 'y' })).rejects.toMatchObject({ code: 'invalid_skill_name' });
    await expect(service.createSkill(ADA, { name: 'factory-triage', description: 'x', instructions: 'y' })).rejects.toMatchObject({ code: 'skill_exists' });
    await expect(service.createSkill(ADA, { name: 'reply-style', description: '', instructions: 'y' })).rejects.toMatchObject({ code: 'invalid_skill' });
    const created = await service.createSkill(ADA, { name: 'reply-style', description: 'How I reply to clients.', instructions: 'Short, warm.' });
    expect(created).toMatchObject({ origin: 'personal', overridden: false, enabled: false, original: null });
    await expect(service.createSkill(ADA, { name: 'reply-style', description: 'x', instructions: 'y' })).rejects.toMatchObject({ code: 'skill_exists' });

    await service.patchSettings(ADA, { skills: ['reply-style'] });
    expect(await service.readSkill(ADA, 'reply-style')).toMatchObject({ instructions: 'Short, warm.' });
    // Bob neither sees it nor can pick it.
    expect((await service.skillsCatalogue(BOB)).map(skill => skill.name)).not.toContain('reply-style');
    await expect(service.patchSettings(BOB, { skills: ['reply-style'] })).rejects.toMatchObject({ code: 'unknown_skill' });
    await expect(service.getSkill(BOB, 'reply-style')).rejects.toMatchObject({ code: 'skill_not_found' });

    await requestOf(ADA, 'hi');
    expect(await run(brain.turns[0]!, 'assistant_read_skill', { name: 'reply-style' })).toEqual({ name: 'reply-style', instructions: 'Short, warm.' });

    expect(await service.deleteSkill(ADA, 'reply-style')).toEqual({ reverted: false, deleted: true });
    expect((await service.getSettings(ADA)).skills).toEqual([]);
  });

  it('are erased with the assistant', async () => {
    await service.createSkill(ADA, { name: 'reply-style', description: 'How I reply.', instructions: 'Short.' });
    await service.saveSkill(ADA, 'product-brief', { description: 'Mine.', instructions: 'Mine.' });
    await service.saveBehavior(ADA, 'Mine.');
    await service.clear(ADA, { reason: 'cleared_by_person', actorId: 'ada' });
    expect(await storage.listOwnSkills(ADA)).toEqual([]);
    expect((await service.getBehavior(ADA)).customized).toBe(false);
  });
});

describe('what the agent sees', () => {
  it('the whole system prompt and every tool with what it may do', async () => {
    await service.saveBehavior(ADA, 'Mine.');
    await service.patchSettings(ADA, { skills: ['product-brief'] });
    const preview = await service.agentPreview(ADA);
    expect(preview.systemPrompt.startsWith('Mine.')).toBe(true);
    expect(preview.systemPrompt).toContain('product-brief: Write a product brief.');
    expect(preview.version).toBe(instructionsVersion(preview.systemPrompt));
    expect(preview.version).toBe((await service.getBehavior(ADA)).version);
    const kinds = Object.fromEntries(preview.tools.map(tool => [tool.name, tool.kind]));
    expect(kinds).toMatchObject({
      assistant_search_requests: 'read',
      assistant_create_note: 'write_own',
      factory_propose_ask: 'proposal',
      factory_propose_hand_over: 'proposal',
      assistant_read_skill: 'read',
    });
    expect(preview.tools.every(tool => tool.description.length > 0)).toBe(true);
    // Bob has no skills: no skill tool.
    expect((await service.agentPreview(BOB)).tools.map(tool => tool.name)).not.toContain('assistant_read_skill');
  });
});

describe('what drove each reply', () => {
  it('keeps the model, the prompt version, the skills and each tool call on the agent’s message', async () => {
    await service.patchSettings(ADA, { skills: ['factory-triage'] });
    brain.answer = async turn => {
      await run(turn, 'assistant_create_note', { text: 'Olena prefers Ukrainian' });
      await run(turn, 'factory_list_attention', { factoryId: 'f-1' });
      return 'done';
    };
    const created = await requestOf(ADA, 'Checkout fails');
    const reply = (await storage.listMessages(ADA, created.id)).find(message => message.author === 'agent')!;
    const preview = await service.agentPreview(ADA);
    expect(reply.details).toMatchObject({
      modelId: null,
      instructionsVersion: preview.version,
      skills: ['factory-triage'],
    });
    expect(reply.details!.toolCalls).toHaveLength(2);
    expect(reply.details!.toolCalls[0]).toMatchObject({ name: 'assistant_create_note', args: '{"text":"Olena prefers Ukrainian"}' });
    expect(reply.details!.toolCalls[0]!.result).toContain('noteId');
    // Factory is not connected: the tool answered with an error, recorded as one.
    expect(reply.details!.toolCalls[1]).toMatchObject({ name: 'factory_list_attention', error: expect.stringContaining('Allow the assistant') });
    expect(reply.details!.toolCalls[1]!.result).toBeUndefined();
  });

  it('records a thrown tool error too, and clips long values', async () => {
    const calls: ToolCallRecord[] = [];
    const tools = recordToolCalls(
      {
        boom: { execute: async () => { throw new Error('kaput'); } },
        big: { execute: async () => 'x'.repeat(2000) },
      },
      calls,
    );
    await expect((tools.boom as ToolLike).execute({}, {})).rejects.toThrow('kaput');
    await (tools.big as ToolLike).execute({ a: 1 }, {});
    expect(calls[0]).toMatchObject({ name: 'boom', error: 'kaput' });
    expect(calls[1]!.result!.length).toBe(500);
  });
});

describe('the model check and how each provider fared', () => {
  it('runs a tiny call; a refusal names the provider’s state; the limit holds', async () => {
    expect(await service.testModel(ADA, 'anthropic/claude-sonnet-4-5')).toMatchObject({ ok: true, modelId: 'anthropic/claude-sonnet-4-5', reply: 'OK', failure: null });
    brain.probeAnswer = () => {
      throw Object.assign(new Error('Too Many Requests'), { statusCode: 429 });
    };
    const failed = await service.testModel(ADA, 'xai/grok-4.5');
    expect(failed).toMatchObject({ ok: false, modelId: 'xai/grok-4.5', failure: { kind: 'rate_limit' } });
    const states = await service.providerStates(ADA);
    expect(states.map(state => [state.provider, state.state])).toEqual([
      ['anthropic', 'ok'],
      ['xai', 'rate_limit'],
    ]);
    expect(await service.providerStates(BOB)).toEqual([]);
    expect((await service.testModel(ADA)).ok).toBe(false);
    await expect(service.testModel(ADA)).rejects.toMatchObject({ code: 'too_many_checks' });
  });
});

describe('routes', () => {
  const auth: RouteAuth = {
    enabled: () => true,
    ensureUser: async () => undefined,
    tenant: (c: Context) => {
      const userId = c.req.header('x-user');
      return userId ? { userId, orgId: 'org-a', role: 'viewer' } : undefined;
    },
    can: async (_c: Context, permission) => can('viewer', permission),
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

  it('behavior, skills, agent preview, model check and status — for a viewer too, each person their own', async () => {
    const put = await send('/web/assistant/behavior', 'PUT', 'ada', { document: 'Mine.' });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ behavior: { document: 'Mine.', customized: true, defaultDocument: ASSISTANT_AGENT_INSTRUCTIONS } });
    expect(await (await send('/web/assistant/behavior', 'GET', 'bob')).json()).toMatchObject({ behavior: { customized: false } });
    expect(await (await send('/web/assistant/behavior', 'DELETE', 'ada')).json()).toMatchObject({ behavior: { customized: false, updatedAt: null } });

    expect((await send('/web/assistant/skills', 'POST', 'ada', { name: 'reply-style', description: 'Mine.', instructions: 'Short.' })).status).toBe(201);
    expect(await (await send('/web/assistant/skills/reply-style', 'GET', 'ada')).json()).toMatchObject({ skill: { origin: 'personal', instructions: 'Short.' } });
    expect((await send('/web/assistant/skills/reply-style', 'GET', 'bob')).status).toBe(404);
    const override = await send('/web/assistant/skills/factory-triage', 'PUT', 'ada', { description: 'Mine.', instructions: 'Mine.' });
    expect(await override.json()).toMatchObject({ skill: { overridden: true, original: { instructions: 'Step 1: read it.' } } });
    expect(await (await send('/web/assistant/skills/factory-triage', 'DELETE', 'ada')).json()).toEqual({ reverted: true, deleted: false });

    const preview = (await (await send('/web/assistant/agent-preview', 'GET', 'ada')).json()) as { preview: { systemPrompt: string; tools: unknown[] } };
    expect(preview.preview.systemPrompt).toContain(ASSISTANT_GUARD);
    expect(preview.preview.tools.length).toBeGreaterThan(10);

    expect(await (await send('/web/assistant/model-test', 'POST', 'ada', { modelId: 'anthropic/claude-sonnet-4-5' })).json()).toMatchObject({ check: { ok: true } });
    expect(await (await send('/web/assistant/model-status', 'GET', 'ada')).json()).toMatchObject({ providers: [{ provider: 'anthropic', state: 'ok' }] });

    const created = await requestOf({ orgId: 'org-a', userId: 'ada' }, 'hi');
    const thread = (await (await send(`/web/assistant/requests/${created.id}`, 'GET', 'ada')).json()) as { messages: Array<{ author: string; details: unknown }> };
    expect(thread.messages.find(message => message.author === 'agent')!.details).toMatchObject({ toolCalls: [] });
  });
});

describe('provider of a model id', () => {
  it('reads Mastra ids and harness ids', () => {
    expect(providerOf('xai/grok-4.5')).toBe('xai');
    expect(providerOf('claude-code:claude-opus-5-5')).toBe('claude-code');
    expect(providerOf('opencode:opencode-go/glm-5.3')).toBe('opencode');
    expect(providerOf(null)).toBeNull();
  });
});
