import { InMemoryStore } from '@mastra/core/storage';
import { RequestContext } from '@mastra/core/request-context';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';

import type { AgentRunEndReason } from '@factory/harness';
import { createClaudeSessionUi } from '@factory/harness-claude-code-ui';
import { createCodexHarness, createInMemoryCodexSessionStore, type CodexSession, type CodexSessionConfig } from '@factory/harness-codex';
import { fakeCodexSpawn, type FakeCodexAppServer } from '@factory/harness-codex/testkit';
import { fakeRouteAuth } from '@factory/http/testing';
import { createSessionAccessGuard } from '@factory/session';

import { chainSessionResolvers, codexAwareModelSelectionReader, isCodexSession } from './sessions.ts';

const BASE = '/api/agent-controller/code/sessions';

type Script = (server: FakeCodexAppServer, turn: { threadId: string; turnId: string }) => void | Promise<void>;

function scripted(scripts: Script[]) {
  let turns = 0;
  return fakeCodexSpawn(server => {
    server.handle('turn/start', params => {
      const turnId = `turn-${++turns}`;
      const script = scripts[Math.min(turns, scripts.length) - 1]!;
      setImmediate(() => {
        server.notify('turn/started', { threadId: params.threadId, turn: { id: turnId, status: 'inProgress' } });
        void script(server, { threadId: params.threadId, turnId });
      });
      return { turn: { id: turnId, status: 'inProgress', items: [] } };
    });
  });
}

const reply =
  (text: string): Script =>
  (server, { threadId, turnId }) => {
    server.notify('item/agentMessage/delta', { threadId, turnId, itemId: `msg-${turnId}`, delta: text });
    server.notify('item/completed', { threadId, turnId, item: { type: 'agentMessage', id: `msg-${turnId}`, text } });
    server.notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } });
  };

const open: Array<() => void> = [];
afterEach(() => {
  for (const close of open.splice(0)) close();
});

async function setup(scripts: Script[], config: Partial<CodexSessionConfig> = {}) {
  const spawn = scripted(scripts);
  const storage = new InMemoryStore();
  const ui = createClaudeSessionUi({ controllerId: 'code', storage, heartbeatMs: 60_000 });
  const harness = createCodexHarness({
    store: createInMemoryCodexSessionStore(),
    spawn,
    cwdFor: () => '/work/card-1',
    env: { PATH: '/usr/bin' },
    turnSelectionFor: async () => ({ model: 'gpt-test-sol', effort: 'medium' }),
    onSession: session => ui.attach(session),
    ...config,
  });
  ui.setSessionResolver(chainSessionResolvers(async () => undefined, id => harness.getSession(id)));
  const session = await harness.createSession({ sessionId: 'card-1', threadId: 'card-1', resourceId: 'factory-1' });

  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('factoryAuthUser' as never, { id: 'owner', organizationId: 'org-1' } as never);
    c.set('requestContext' as never, new RequestContext() as never);
    await next();
  });
  app.use(
    '*',
    createSessionAccessGuard({
      auth: fakeRouteAuth(),
      sessions: { getBySessionId: async id => (id === 'card-1' ? ({ sessionId: id, orgId: 'org-1', userId: 'owner', visibility: 'org' } as never) : null) },
      projects: { get: async ({ orgId, id }) => (id === 'factory-1' && orgId === 'org-1' ? ({ id, orgId } as never) : null) },
      controller: () => ({
        getSession: async () => undefined,
        queryThreadById: async ({ threadId }) => (threadId === 'card-1' ? { resourceId: 'factory-1' } : null),
      }),
    }),
  );
  app.use('*', ui.middleware());
  app.all('*', c => c.json({ mastra: true }));
  return { app, ui, harness, session, spawn };
}

function nextEnd(session: CodexSession): Promise<AgentRunEndReason | undefined> {
  return new Promise(resolve => {
    const off = session.subscribe(event => {
      if (event.type !== 'agent_end') return;
      off();
      resolve(event.reason);
    });
  });
}

function post(app: Hono, path: string, body: unknown = {}) {
  return app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

async function history(app: Hono): Promise<Array<Record<string, any>>> {
  return ((await (await app.request(`${BASE}/card-1/threads/card-1/messages?limit=100`)).json()) as { messages: Array<Record<string, any>> }).messages;
}

async function openStream(app: Hono) {
  const controller = new AbortController();
  const response = await app.request(`${BASE}/card-1/stream`, { signal: controller.signal });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const events: Array<Record<string, unknown>> = [];
  let buffer = '';
  open.push(() => {
    controller.abort();
    void reader.cancel().catch(() => {});
  });
  return {
    async until(match: (event: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
      for (;;) {
        const found = events.find(match);
        if (found) return found;
        const { done, value } = await reader.read();
        if (done) throw new Error('stream ended');
        buffer += decoder.decode(value, { stream: true });
        let separator: number;
        while ((separator = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, separator);
          buffer = buffer.slice(separator + 2);
          for (const line of frame.split('\n')) if (line.startsWith('data:')) events.push(JSON.parse(line.slice(5)));
        }
      }
    },
  };
}

describe('Codex sessions in the chat', () => {
  it('runs a chat message as a Codex turn and stores the reply as an OpenAI model reply', async () => {
    const { app, session, spawn } = await setup([reply('Fixed it.')]);
    const ended = nextEnd(session);
    expect(await (await post(app, `${BASE}/card-1/messages`, { message: 'Fix the bug' })).json()).toMatchObject({ ok: true });
    expect(await ended).toBe('complete');
    expect((spawn.servers[0]!.requests('turn/start')[0]!.params as any).input[0].text).toBe('Fix the bug');
    const messages = await history(app);
    const assistant = messages.find(message => message.role === 'assistant')!;
    expect(assistant.content.parts).toEqual([expect.objectContaining({ type: 'text', text: 'Fixed it.' })]);
    expect(assistant.content.metadata).toMatchObject({ modelId: 'gpt-test-sol', provider: 'openai' });
    expect(messages.some(message => JSON.stringify(message).includes('Fix the bug'))).toBe(true);
  });

  it('asks for a command approval in the chat and goes on in the same turn once allowed', async () => {
    let decision: unknown;
    const { app, session, spawn } = await setup([
      async (server, { threadId, turnId }) => {
        decision = (await server.request('item/commandExecution/requestApproval', { threadId, turnId, itemId: 'cmd-1', command: 'pnpm test', cwd: '/work/card-1' })).result;
        server.notify('item/started', { threadId, turnId, item: { type: 'commandExecution', id: 'cmd-1', command: 'pnpm test', cwd: '/work/card-1', status: 'inProgress' } });
        server.notify('item/completed', { threadId, turnId, item: { type: 'commandExecution', id: 'cmd-1', command: 'pnpm test', cwd: '/work/card-1', status: 'completed', aggregatedOutput: 'ok', exitCode: 0 } });
        reply('Tests pass.')(server, { threadId, turnId });
      },
    ]);
    const stream = await openStream(app);
    const parked = nextEnd(session);
    await post(app, `${BASE}/card-1/messages`, { message: 'Run the tests' });
    expect(await parked).toBe('suspended');
    expect(await stream.until(event => event.type === 'tool_approval_required')).toEqual({
      type: 'tool_approval_required',
      toolCallId: 'cmd-1',
      toolName: 'execute_command',
      args: { command: 'pnpm test', cwd: '/work/card-1' },
    });
    const before = (await history(app)).find(message => message.role === 'assistant')!;
    expect(before.content.metadata.pendingToolApprovals['cmd-1']).toMatchObject({ toolName: 'execute_command' });

    const resumed = nextEnd(session);
    expect(await (await post(app, `${BASE}/card-1/tool-approval`, { toolCallId: 'cmd-1', approved: true })).json()).toEqual({ ok: true });
    expect(await resumed).toBe('complete');
    expect(decision).toEqual({ decision: 'acceptForSession' });
    expect(spawn.servers).toHaveLength(1);
    const after = await history(app);
    const settled = after.find(message => message.id === before.id)!;
    expect(settled.content.metadata?.pendingToolApprovals).toBeUndefined();
    const parts = after.filter(message => message.role === 'assistant').flatMap(message => message.content.parts);
    expect(parts).toContainEqual(expect.objectContaining({ toolInvocation: expect.objectContaining({ toolCallId: 'cmd-1:0:run', state: 'result', result: 'ok\n\nExit code 0' }) }));
  });

  it("shows Codex's question as the question card and gives Codex the answer", async () => {
    let answers: unknown;
    const { app, session } = await setup([
      async (server, { threadId, turnId }) => {
        answers = (
          await server.request('item/tool/requestUserInput', {
            threadId,
            turnId,
            itemId: 'q-1',
            questions: [{ id: 'side', header: 'Side', question: 'Which side?', options: [{ label: 'Frontend', description: 'UI' }, { label: 'Backend', description: '' }] }],
          })
        ).result;
        reply('On it.')(server, { threadId, turnId });
      },
    ]);
    const stream = await openStream(app);
    const parked = nextEnd(session);
    await post(app, `${BASE}/card-1/messages`, { message: 'Fix the bug' });
    expect(await parked).toBe('suspended');
    const question = { question: 'Which side?', options: [{ label: 'Frontend', description: 'UI' }, { label: 'Backend' }], selectionMode: 'single_select' };
    expect(await stream.until(event => event.type === 'tool_suspended')).toEqual({
      type: 'tool_suspended',
      toolCallId: 'q-1',
      toolName: 'ask_user',
      args: question,
      suspendPayload: question,
    });
    const resumed = nextEnd(session);
    expect(await (await post(app, `${BASE}/card-1/tool-suspension`, { toolCallId: 'q-1', resumeData: 'Backend' })).json()).toEqual({ ok: true });
    expect(await resumed).toBe('complete');
    expect(answers).toEqual({ answers: { side: { answers: ['Backend'] } } });
  });

  it("shows Codex's plan list as the task panel", async () => {
    const { app, session } = await setup([
      (server, { threadId, turnId }) => {
        server.notify('turn/plan/updated', { threadId, turnId, plan: [{ step: 'Read the code', status: 'inProgress' }, { step: 'Fix it', status: 'pending' }] });
        reply('Working.')(server, { threadId, turnId });
      },
    ]);
    const stream = await openStream(app);
    const ended = nextEnd(session);
    await post(app, `${BASE}/card-1/messages`, { message: 'Plan it' });
    expect(await ended).toBe('complete');
    const update = (await stream.until(event => event.type === 'task_updated')) as { tasks: Array<Record<string, unknown>> };
    expect(update.tasks.map(task => [task.content, task.status])).toEqual([
      ['Read the code', 'in_progress'],
      ['Fix it', 'pending'],
    ]);
  });

  it('parks on a plan-mode plan as the plan card and implements it once approved from the chat', async () => {
    const { app, session, spawn } = await setup(
      [
        (server, { threadId, turnId }) => {
          server.notify('item/completed', { threadId, turnId, item: { type: 'plan', id: 'plan-1', text: '# Cache it\n\n1. Add a cache' } });
          server.notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } });
        },
        reply('Cached.'),
      ],
      { mode: 'planning' },
    );
    const stream = await openStream(app);
    const parked = nextEnd(session);
    await post(app, `${BASE}/card-1/messages`, { message: 'Speed it up' });
    expect(await parked).toBe('suspended');
    expect(await stream.until(event => event.type === 'tool_suspended')).toMatchObject({
      toolCallId: 'plan-1:submit_plan',
      toolName: 'submit_plan',
      args: { title: 'Cache it', plan: '# Cache it\n\n1. Add a cache' },
    });
    const resumed = nextEnd(session);
    expect(
      await (await post(app, `${BASE}/card-1/tool-suspension`, { toolCallId: 'plan-1:submit_plan', resumeData: { action: 'approved' } })).json(),
    ).toEqual({ ok: true });
    expect(await resumed).toBe('complete');
    expect((spawn.servers[1]!.requests('turn/start')[0]!.params as any).input[0].text).toBe('The plan was approved. Implement it.');
  });

  it("reads a Codex session's model selection from Codex's facet", async () => {
    const { session } = await setup([reply('ok')]);
    const selection = { instanceId: 'codex', model: 'gpt-test-sol' };
    const reader = codexAwareModelSelectionReader({ effectiveSelection: async () => selection }, async () => ({ instanceId: 'claude-code', model: 'opus' }));
    expect(isCodexSession(session)).toBe(true);
    expect(await reader(session)).toEqual(selection);
    expect(await reader({ ...session, id: 'other' } as never)).toEqual({ instanceId: 'claude-code', model: 'opus' });
  });
});

describe('chainSessionResolvers', () => {
  it('asks each harness in turn', async () => {
    const found = { id: 'x' } as never;
    const resolve = chainSessionResolvers(undefined, async () => undefined, async id => (id === 'x' ? found : undefined));
    expect(await resolve('x')).toBe(found);
    expect(await resolve('y')).toBeUndefined();
  });
});
