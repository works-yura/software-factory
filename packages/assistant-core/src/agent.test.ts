/**
 * The Mastra agent with a stand-in model: it remembers under `assistant:<orgId>:<userId>` with one
 * thread per request, sees screenshots as images, and its memory is erased per owner.
 */
import { LibSQLFactoryStorage } from '@mastra/libsql';
import { beforeEach, describe, expect, it } from 'vitest';

import { createAssistantMemory, createAssistantMemoryEraser, createMastraAssistantBrain } from './agent.ts';
import type { BrainTurn } from './ports.ts';
import { AssistantTurnError, classifyTurnFailure } from './turn-failure.ts';
import type { AssistantOwner, AssistantRequest } from './types.ts';

const ADA: AssistantOwner = { orgId: 'org-a', userId: 'ada' };
const BOB: AssistantOwner = { orgId: 'org-a', userId: 'bob' };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);

let prompts: unknown[];
let resolved: Array<{ owner: AssistantOwner; modelId: string | null }>;

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const model = {
  specificationVersion: 'v2' as const,
  provider: 'test',
  modelId: 'test-model',
  supportedUrls: {},
  async doGenerate(options: { prompt: unknown }) {
    prompts.push(options.prompt);
    return { content: [{ type: 'text', text: 'Olena asks about checkout.' }], finishReason: 'stop', usage, warnings: [] };
  },
  async doStream(options: { prompt: unknown }) {
    prompts.push(options.prompt);
    return {
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] });
          controller.enqueue({ type: 'text-start', id: 't1' });
          controller.enqueue({ type: 'text-delta', id: 't1', delta: 'Olena asks about checkout.' });
          controller.enqueue({ type: 'text-end', id: 't1' });
          controller.enqueue({ type: 'finish', finishReason: 'stop', usage });
          controller.close();
        },
      }),
    };
  },
};

function request(owner: AssistantOwner, id: string): AssistantRequest {
  const at = new Date();
  return {
    id,
    owner,
    topic: 'Checkout fails',
    fromName: 'Olena',
    source: 'manual',
    sourceUrl: null,
    sourceKey: null,
    previousRequestId: null,
    status: 'new',
    factory: null,
    analysing: true,
    lastError: null,
    unread: false,
    createdAt: at,
    updatedAt: at,
    closedAt: null,
  };
}

let backend: LibSQLFactoryStorage;

beforeEach(async () => {
  backend = new LibSQLFactoryStorage({ id: 'assistant-agent', url: ':memory:' });
  await backend.init();
  prompts = [];
  resolved = [];
});

function brain() {
  return createMastraAssistantBrain({
    memory: createAssistantMemory(backend.getMastraStorage()),
    models: {
      async resolve(owner, modelId) {
        resolved.push({ owner, modelId });
        return { model: model as never };
      },
    },
  });
}

function turn(owner: AssistantOwner, id: string, files: BrainTurn['input']['files'] = []): BrainTurn {
  return { owner, request: request(owner, id), input: { author: 'person', text: 'see screenshot', files }, modelId: 'test/test-model' };
}

describe('the assistant agent', () => {
  it('reads the screenshot as an image and remembers the turn under the owner, one thread per request', async () => {
    const answer = await brain().respond(turn(ADA, '11111111-1111-4111-8111-111111111111', [{ name: 'shot.png', mime: 'image/png', bytes: PNG }]));

    expect(answer).toEqual({ text: 'Olena asks about checkout.' });
    expect(resolved).toEqual([{ owner: ADA, modelId: 'test/test-model' }]);
    const prompt = JSON.stringify(prompts[0]);
    expect(prompt).toContain('Request: Checkout fails');
    expect(prompt).toContain('From: Olena');
    expect(prompt).toContain('image/png');

    const memory = await backend.getMastraStorage().getStore('memory');
    const { threads } = await memory!.listThreads({ filter: { resourceId: 'assistant:org-a:ada' }, perPage: false });
    expect(threads.map(thread => thread.id)).toEqual(['11111111-1111-4111-8111-111111111111']);
  });

  it('fails loudly when the organization has no model', async () => {
    const failing = createMastraAssistantBrain({
      memory: createAssistantMemory(backend.getMastraStorage()),
      models: {
        async resolve() {
          throw new Error('Your organization has no model connected.');
        },
      },
    });
    await expect(failing.respond(turn(ADA, '22222222-2222-4222-8222-222222222222'))).rejects.toThrow('no model connected');
  });

  it('names the resolved model when the provider refuses the turn (xAI 429), keeping its words as the cause', async () => {
    const limited = {
      ...model,
      async doGenerate() {
        throw Object.assign(new Error('Too Many Requests'), {
          statusCode: 429,
          responseBody: '{"code":"Some resource has been exhausted"}',
          isRetryable: false,
        });
      },
      async doStream() {
        throw Object.assign(new Error('Too Many Requests'), {
          statusCode: 429,
          responseBody: '{"code":"Some resource has been exhausted"}',
          isRetryable: false,
        });
      },
    };
    const failing = createMastraAssistantBrain({
      memory: createAssistantMemory(backend.getMastraStorage()),
      models: {
        async resolve() {
          return { model: limited as never, modelId: 'xai/grok-4.5' };
        },
      },
    });
    const error = await failing
      .respond({ ...turn(ADA, '66666666-6666-4666-8666-666666666666'), modelId: null })
      .then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(AssistantTurnError);
    expect(classifyTurnFailure(error)).toMatchObject({ kind: 'rate_limit', modelId: 'xai/grok-4.5', status: 429 });
  });

  it('erases one owner’s memory, and one request’s thread, never another’s', async () => {
    await brain().respond(turn(ADA, '33333333-3333-4333-8333-333333333333'));
    await brain().respond(turn(ADA, '44444444-4444-4444-8444-444444444444'));
    await brain().respond(turn(BOB, '55555555-5555-4555-8555-555555555555'));
    const eraser = createAssistantMemoryEraser(backend.getMastraStorage());
    const memory = (await backend.getMastraStorage().getStore('memory'))!;
    const threadsOf = async (resourceId: string) =>
      (await memory.listThreads({ filter: { resourceId }, perPage: false })).threads.map(thread => thread.id).sort();

    await eraser.forgetThread(BOB, '33333333-3333-4333-8333-333333333333');
    expect(await threadsOf('assistant:org-a:ada')).toHaveLength(2);
    await eraser.forgetThread(ADA, '33333333-3333-4333-8333-333333333333');
    expect(await threadsOf('assistant:org-a:ada')).toEqual(['44444444-4444-4444-8444-444444444444']);

    await eraser.forget(ADA);
    expect(await threadsOf('assistant:org-a:ada')).toEqual([]);
    expect(await threadsOf('assistant:org-a:bob')).toEqual(['55555555-5555-4555-8555-555555555555']);
    const messages = await memory.listMessages({ threadId: '33333333-3333-4333-8333-333333333333' });
    expect(messages.messages).toEqual([]);
  });
});
