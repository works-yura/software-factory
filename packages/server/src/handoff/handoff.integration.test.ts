// Moving a session between the three harnesses with a context handoff, end to end: real Claude
// Code and Codex sessions (fake CLI and fake app-server), a real Mastra agent (mock model) over the
// same memory store, the chat channel recording the turn-based transcripts into the session's
// thread, and the model registry's harness switch. No real model is called.
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Agent } from '@mastra/core/agent';
import { MockMemory } from '@mastra/core/memory';
import { RequestContext } from '@mastra/core/request-context';
import { InMemoryStore } from '@mastra/core/storage';
import { createMockModel } from '@mastra/core/test-utils/llm-mock';
import { afterEach, describe, expect, it } from 'vitest';

import { createHarnessModelRegistry } from '@factory/harness';
import type { HarnessModels } from '@factory/harness';
import { fakeClaude, type FakeTurn } from '@factory/harness-claude-code/__fixtures__/fake-claude';
import { createClaudeCodeHarness, createInMemorySessionStore } from '@factory/harness-claude-code';
import type { ClaudeCodeSession } from '@factory/harness-claude-code';
import { attachClaudeSessionToUi } from '@factory/harness-claude-code-ui';
import type { ClaudeSessionUiChannel } from '@factory/harness-claude-code-ui';
import { createCodexHarness, createInMemoryCodexSessionStore } from '@factory/harness-codex';
import type { CodexSession } from '@factory/harness-codex';
import { fakeCodexSpawn } from '@factory/harness-codex/testkit';
import {
  CONTEXT_HANDOFF_SIGNAL_TAG,
  createMemoryHistorySource,
  createSessionHandoffs,
  readThread,
  threadReadSourceFromHistory,
} from '@factory/harness-handoff';
import { FactoryContextHandoffProcessor } from '@factory/harness-handoff/mastra';

import { createHarnessSwitch, turnHandoffHook } from './harness-switch.ts';

const SESSION = 'session-1';
const RESOURCE = 'resource-1';
const LABELS: Record<string, string> = { mastra: 'Mastra', 'claude-code': 'Claude Code', codex: 'Codex' };
type Instance = 'mastra' | 'claude-code' | 'codex';
const ctx = { viewer: { userId: 'ann', orgId: 'org-1' } };

const pending: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of pending.splice(0)) cleanup();
});

function claudeTurn(text: string): FakeTurn {
  const sid = 'cc-native-1';
  return {
    lines: [
      JSON.stringify({ type: 'system', subtype: 'init', cwd: '/w', session_id: sid, model: 'claude-sonnet-4-6', permissionMode: 'acceptEdits' }),
      JSON.stringify({
        type: 'assistant',
        message: { id: `msg-${text}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } },
        parent_tool_use_id: null,
        session_id: sid,
      }),
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: text, session_id: sid, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } }),
    ],
  };
}

function stubFacet(instanceId: Instance, owns: (sessionId: string) => Promise<boolean>): HarnessModels {
  return {
    instanceId,
    harnessId: instanceId,
    displayName: LABELS[instanceId]!,
    owns,
    list: async () => [],
    defaultSelection: async () => null,
    catalogDefault: async () => null,
    check: async request => ({ ok: true, selection: { instanceId, model: request.model } }),
    getSelection: async () => null,
    setSelection: async (_sessionId, selection) => ({ ok: true, modelSelection: selection, appliesFrom: 'next-turn' }),
  };
}

async function world(options: { tokenCap?: number } = {}) {
  const store = new InMemoryStore();
  const memory = (await store.getStore('memory'))!;
  const storage = { getStore: async () => memory };
  const handoffs = createSessionHandoffs({
    memory: async () => memory,
    label: id => LABELS[id] ?? id,
    ...(options.tokenCap ? { tokenCap: options.tokenCap } : {}),
  });
  const cwd = await mkdtemp(join(tmpdir(), 'handoff-it-'));
  const channels = new Map<string, ClaudeSessionUiChannel>();
  const attach = (session: ClaudeCodeSession | CodexSession) => channels.set(session.id, attachClaudeSessionToUi(session, { storage }));
  const hookDeps = { handoffs: () => handoffs, memory: async () => memory };

  // Claude Code: a scripted CLI; each spawn plays the next queued turn and records its prompt.
  const claudeTurns: FakeTurn[] = [];
  const claudeFake = fakeClaude(claudeTurns);
  const claudeStore = createInMemorySessionStore();
  const claude = createClaudeCodeHarness({
    store: claudeStore,
    spawn: claudeFake.spawn,
    credentials: async () => ({ ANTHROPIC_API_KEY: 'sk-test' }),
    cwdFor: () => cwd,
    env: { PATH: '/usr/bin' },
    handoffContextFor: turnHandoffHook<ClaudeCodeSession>('claude-code', hookDeps),
    onSession: attach,
  });

  // Codex: a fake app-server that answers each turn with the next queued reply.
  const codexReplies: string[] = [];
  let codexThreadsLost = false;
  const codexSpawn = fakeCodexSpawn(server => {
    let turns = 0;
    if (codexThreadsLost) {
      server.handle('thread/resume', () => {
        throw new Error('no rollout found for thread');
      });
    }
    server.handle('turn/start', params => {
      const turnId = `turn-${++turns}`;
      const text = codexReplies.shift() ?? 'ok';
      setImmediate(() => {
        server.notify('turn/started', { threadId: params.threadId, turn: { id: turnId, status: 'inProgress' } } as never);
        server.notify('item/completed', { threadId: params.threadId, turnId, item: { type: 'agentMessage', id: `msg-${turnId}`, text } } as never);
        server.notify('turn/completed', { threadId: params.threadId, turn: { id: turnId, status: 'completed' } } as never);
      });
      return { turn: { id: turnId, status: 'inProgress', items: [] } };
    });
  });
  const codexStore = createInMemoryCodexSessionStore();
  const codex = createCodexHarness({
    store: codexStore,
    spawn: codexSpawn,
    cwdFor: () => cwd,
    env: { PATH: '/usr/bin' },
    handoffContextFor: turnHandoffHook<CodexSession>('codex', hookDeps),
    onSession: attach,
  });

  // Mastra: a real agent on the same memory store; its mock model records every prompt.
  const mastraPrompts: string[] = [];
  const mastraReplies: string[] = [];
  const mastraMemory = new MockMemory({ storage: store });
  const runMastra = async (content: string) => {
    const agent = new Agent({
      id: 'factory',
      name: 'factory',
      instructions: 'You are a Factory agent.',
      model: createMockModel({
        mockText: mastraReplies.shift() ?? 'ok',
        spyStream: props => mastraPrompts.push(JSON.stringify((props as { prompt?: unknown }).prompt)),
      }),
      memory: mastraMemory,
      inputProcessors: [new FactoryContextHandoffProcessor(() => handoffs)],
    });
    const requestContext = new RequestContext();
    requestContext.set('controller', { sessionId: SESSION, threadId: SESSION, resourceId: RESOURCE });
    const stream = await agent.stream(content, { memory: { thread: SESSION, resource: RESOURCE }, requestContext });
    for await (const _chunk of stream.fullStream) void _chunk;
  };

  const registry = createHarnessModelRegistry([
    stubFacet('claude-code', async id => (await claudeStore.get(id)) !== undefined),
    stubFacet('codex', async id => (await codexStore.get(id)) !== undefined),
  ]);
  registry.register(stubFacet('mastra', async () => true), { fallback: true });
  const turnBinding = (harness: typeof claude | typeof codex) => ({
    adopt: async ({ sessionId, threadId, resourceId }: { sessionId: string; threadId: string; resourceId: string }) => {
      await harness.createSession({ sessionId, threadId, resourceId });
    },
    release: async (sessionId: string) => {
      const channel = channels.get(sessionId);
      if (channel) {
        await channel.flushed();
        channel.detach();
        channels.delete(sessionId);
      }
      await harness.releaseSession(sessionId);
    },
  });
  registry.setHarnessSwitch(
    createHarnessSwitch({
      handoffs,
      memory: async () => memory,
      sessions: { getBySessionId: async () => ({ orgId: 'org-1', factoryProjectId: 'factory-1', userId: 'ann', title: 'Login bug' }) as never },
      isRunning: () => false,
      bindings: { mastra: { adopt: async () => {}, release: async () => {} }, 'claude-code': turnBinding(claude), codex: turnBinding(codex) },
    }),
  );

  /** One turn on whichever harness holds the session; returns the prompt the provider received. */
  const turn = async (content: string, reply: string): Promise<{ on: Instance; prompt: string }> => {
    const on = (await registry.forSession(SESSION))!.instanceId as Instance;
    if (on === 'mastra') {
      mastraReplies.push(reply);
      await runMastra(content);
      return { on, prompt: mastraPrompts.at(-1)! };
    }
    if (on === 'claude-code') {
      claudeTurns.push(claudeTurn(reply));
      const session = (await claude.getSession(SESSION))!;
      await session.sendMessage({ content });
      await channels.get(SESSION)?.flushed();
      return { on, prompt: claudeFake.calls.at(-1)!.stdin! };
    }
    codexReplies.push(reply);
    const session = (await codex.getSession(SESSION))!;
    await session.sendMessage({ content });
    await channels.get(SESSION)?.flushed();
    const request = codexSpawn.servers.at(-1)!.requests('turn/start').at(-1)!;
    return { on, prompt: (request.params as { input: Array<{ text: string }> }).input[0]!.text };
  };

  const startOn = async (instance: Instance) => {
    if (instance === 'mastra') return;
    const harness = instance === 'claude-code' ? claude : codex;
    await harness.createSession({ sessionId: SESSION, threadId: SESSION, resourceId: RESOURCE });
  };

  const markers = async () => {
    const { messages } = await memory.listMessages({ threadId: SESSION, perPage: false });
    return messages
      .filter(message => (message.content.metadata?.signal as { tagName?: string } | undefined)?.tagName === CONTEXT_HANDOFF_SIGNAL_TAG)
      .map(message => message.content.metadata?.contextHandoff as { from: string; to: string; status: string; reason: string });
  };

  pending.push(() => {
    for (const channel of channels.values()) channel.detach();
  });
  return {
    memory,
    registry,
    handoffs,
    turn,
    startOn,
    markers,
    claudeFake,
    claudeTurns,
    codexSpawn,
    mastraPrompts,
    loseCodexThreads: () => {
      codexThreadsLost = true;
    },
  };
}

const DIRECTIONS: Array<[Instance, Instance]> = [
  ['mastra', 'claude-code'],
  ['claude-code', 'codex'],
  ['codex', 'mastra'],
  ['claude-code', 'mastra'],
  ['codex', 'claude-code'],
  ['mastra', 'codex'],
];

describe('context handoff between harnesses', () => {
  it.each(DIRECTIONS)('%s → %s: the first turn on the target gets the real history once, the request untouched', async (from, to) => {
    const w = await world();
    await w.startOn(from);
    const first = await w.turn('Rename the login handler to handleSignIn', `Renamed it on ${from}.`);
    expect(first.on).toBe(from);

    const switched = await w.registry.switchSessionModel(SESSION, { model: `${to}-model`, instanceId: to }, ctx);
    expect(switched).toMatchObject({ ok: true, handoff: { fromInstanceId: from, toInstanceId: to } });
    expect(await w.markers()).toEqual([expect.objectContaining({ from: LABELS[from], to: LABELS[to], status: 'pending', reason: 'switch' })]);

    const request = 'Now add a test for it';
    const second = await w.turn(request, `Added the test on ${to}.`);
    expect(second.on).toBe(to);
    // The target's first turn carries the source's real messages, both sides, with the recovery tool.
    expect(second.prompt).toContain('Rename the login handler to handleSignIn');
    expect(second.prompt).toContain(`Renamed it on ${from}.`);
    expect(second.prompt).toContain('factory_thread_read');
    if (to === 'mastra') {
      // As a system message; the person's message goes to the model as written.
      const prompt = JSON.parse(second.prompt) as Array<{ role: string; content: unknown }>;
      const system = prompt.filter(message => message.role === 'system').map(message => JSON.stringify(message.content)).join('\n');
      expect(system).toContain(`Renamed it on ${from}.`);
      const lastUser = prompt.filter(message => message.role === 'user').at(-1);
      expect(JSON.stringify(lastUser?.content)).toContain(request);
      expect(JSON.stringify(lastUser?.content)).not.toContain('Historical');
    } else {
      expect(second.prompt.endsWith(`User message:\n${request}`)).toBe(true);
    }
    expect(await w.markers()).toEqual([expect.objectContaining({ status: 'delivered' })]);

    // Delivered once: the next turn on the target carries no history again.
    const third = await w.turn('And document it', 'Documented.');
    expect(third.on).toBe(to);
    expect(third.prompt).not.toContain('Historical');
    if (to !== 'mastra') expect(third.prompt).toBe('And document it');
  });

  it('names what did not fit, and factory_thread_read returns those items', async () => {
    const w = await world({ tokenCap: 1_024 });
    await w.startOn('claude-code');
    for (let index = 0; index < 4; index++) {
      await w.turn(`Question ${index}: ${'detail '.repeat(40)}`, `Answer ${index}: ${'more '.repeat(40)}`);
    }
    await w.registry.switchSessionModel(SESSION, { model: 'gpt', instanceId: 'codex' }, ctx);
    const { prompt } = await w.turn('Continue', 'Continuing.');
    const omitted = Number(/omitted (\d+) items/.exec(prompt)?.[1]);
    expect(omitted).toBeGreaterThan(0);
    expect(prompt).toContain(`factory_thread_read({threadId:"${SESSION}"`);
    expect(prompt).not.toContain('Question 0:');
    expect(prompt.endsWith('User message:\nContinue')).toBe(true);

    const source = threadReadSourceFromHistory(createMemoryHistorySource({ memory: async () => w.memory }));
    const page = await readThread(source, { threadId: SESSION, limit: 100 });
    expect(page.items.map(item => item.text)).toEqual(expect.arrayContaining([expect.stringContaining('Question 0:'), expect.stringContaining('Answer 0:')]));
  });

  it('refuses a move while the session runs, and from a session without a Factory row', async () => {
    const w = await world();
    const running = createHarnessSwitch({
      handoffs: w.handoffs,
      memory: async () => w.memory,
      sessions: { getBySessionId: async () => ({ orgId: 'o', factoryProjectId: 'f', userId: 'u' }) as never },
      isRunning: () => true,
      bindings: { mastra: { adopt: async () => {}, release: async () => {} }, codex: { adopt: async () => {}, release: async () => {} } },
    });
    const from = w.registry.forInstance('mastra')!;
    const to = w.registry.forInstance('codex')!;
    expect(await running.switchHarness({ sessionId: SESSION, from, to, request: { model: 'gpt', instanceId: 'codex' }, ctx })).toMatchObject({
      ok: false,
      status: 409,
      error: expect.stringMatching(/running/),
    });
    const rowless = createHarnessSwitch({
      handoffs: w.handoffs,
      memory: async () => w.memory,
      sessions: { getBySessionId: async () => null },
      isRunning: () => false,
      bindings: { mastra: { adopt: async () => {}, release: async () => {} }, codex: { adopt: async () => {}, release: async () => {} } },
    });
    expect(await rowless.switchHarness({ sessionId: SESSION, from, to, request: { model: 'gpt', instanceId: 'codex' }, ctx })).toMatchObject({
      ok: false,
      status: 409,
    });
  });
});

describe('a native conversation that cannot be resumed', () => {
  it('Claude Code: the fresh CLI session gets the thread history instead of none, once', async () => {
    const w = await world();
    await w.startOn('claude-code');
    await w.turn('Explain the cache layer', 'It is an LRU in front of Redis.');
    // The CLI lost the conversation: the resume fails, and the turn starts a fresh one.
    w.claudeTurns.push({
      lines: [
        JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 0, session_id: 'x', errors: ['No conversation found with session ID: cc-native-1'] }),
      ],
      exitCode: 1,
    });
    const { prompt } = await w.turn('Where does it evict?', 'On write.');
    const calls = w.claudeFake.calls;
    expect(calls.at(-2)!.args).toContain('--resume');
    expect(calls.at(-2)!.stdin).toBe('Where does it evict?');
    expect(calls.at(-1)!.args).not.toContain('--resume');
    expect(prompt).toContain('Explain the cache layer');
    expect(prompt).toContain('It is an LRU in front of Redis.');
    // This turn's own request is not history: it is sent once, at the end, as written.
    expect(prompt.split('Where does it evict?')).toHaveLength(2);
    expect(prompt.endsWith('User message:\nWhere does it evict?')).toBe(true);
    expect(await w.markers()).toEqual([
      expect.objectContaining({ from: 'Claude Code', to: 'Claude Code', reason: 'resume_failed', status: 'delivered' }),
    ]);
    expect((await w.turn('Thanks', 'Welcome.')).prompt).toBe('Thanks');
  });

  it('Codex: the new thread after a failed resume gets the thread history instead of none, once', async () => {
    const w = await world();
    await w.startOn('codex');
    await w.turn('Explain the cache layer', 'It is an LRU in front of Redis.');
    w.loseCodexThreads();
    const { prompt } = await w.turn('Where does it evict?', 'On write.');
    const server = w.codexSpawn.servers.at(-1)!;
    expect(server.requests('thread/resume')).toHaveLength(1);
    expect(server.requests('thread/start')).toHaveLength(1);
    expect(prompt).toContain('Explain the cache layer');
    expect(prompt).toContain('It is an LRU in front of Redis.');
    expect(prompt.split('Where does it evict?')).toHaveLength(2);
    expect(prompt.endsWith('User message:\nWhere does it evict?')).toBe(true);
    expect(await w.markers()).toEqual([expect.objectContaining({ to: 'Codex', reason: 'resume_failed', status: 'delivered' })]);
  });
});
