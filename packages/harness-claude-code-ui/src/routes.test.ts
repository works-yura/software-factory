import { InMemoryStore } from '@mastra/core/storage';
import { RequestContext } from '@mastra/core/request-context';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentRunEndReason } from '@factory/harness';
import {
  createClaudeCodeHarness,
  createInMemorySessionStore,
  type ClaudeCodeHarness,
  type ClaudeCodeSession,
} from '@factory/harness-claude-code';
import { fakeClaude, fixture, type FakeTurn } from '@factory/harness-claude-code/__fixtures__/fake-claude';
import { fakeRouteAuth, type TestAuthUser } from '@factory/http/testing';
import { createSessionAccessGuard } from '@factory/session';

import { createClaudeSessionUi, type ClaudeSessionUi } from './routes.ts';

const BASE = '/api/agent-controller/code/sessions';
const OWNER: TestAuthUser = { workosId: 'owner', organizationId: 'org-1' };

interface Setup {
  app: Hono;
  ui: ClaudeSessionUi;
  harness: ClaudeCodeHarness;
  session: ClaudeCodeSession;
  fake: ReturnType<typeof fakeClaude>;
  storage: InMemoryStore;
}

const open: Array<() => void> = [];
afterEach(() => {
  for (const close of open.splice(0)) close();
});

async function setup(turns: FakeTurn[], options: { user?: TestAuthUser; mode?: 'planning'; visibility?: 'private' | 'org' } = {}): Promise<Setup> {
  const fake = fakeClaude(turns);
  const storage = new InMemoryStore();
  const ui = createClaudeSessionUi({ controllerId: 'code', storage, heartbeatMs: 60_000 });
  const harness = createClaudeCodeHarness({
    store: createInMemorySessionStore(),
    spawn: fake.spawn,
    credentials: async () => ({ ANTHROPIC_API_KEY: 'sk-test' }),
    cwdFor: () => '/work/card-1',
    env: { PATH: '/usr/bin' },
    ...(options.mode ? { mode: options.mode } : {}),
    onSession: session => ui.attach(session),
  });
  ui.setSessionResolver(id => harness.getSession(id));
  const session = await harness.createSession({ sessionId: 'card-1', threadId: 'card-1', resourceId: 'factory-1' });

  const rows = new Map([['card-1', { sessionId: 'card-1', orgId: 'org-1', userId: 'owner', visibility: options.visibility ?? 'org' }]]);
  const app = new Hono();
  const user = options.user ?? OWNER;
  app.use('*', async (c, next) => {
    c.set('factoryAuthUser' as never, user as never);
    c.set('requestContext' as never, new RequestContext() as never);
    await next();
  });
  app.use(
    '*',
    createSessionAccessGuard({
      auth: fakeRouteAuth(),
      sessions: { getBySessionId: async id => (rows.get(id) ?? null) as never },
      projects: { get: async ({ orgId, id }) => (id === 'factory-1' && orgId === 'org-1' ? ({ id, orgId } as never) : null) },
      controller: () => ({
        getSession: async () => undefined,
        queryThreadById: async ({ threadId }) => (threadId === 'card-1' ? { resourceId: 'factory-1' } : null),
      }),
    }),
  );
  app.use('*', ui.middleware());
  // Stand-ins for the Mastra handlers a request falls through to.
  app.get('/api/agent-controller/code/active-runs', c => c.json({ runs: [{ runId: 'mastra-run', threadId: 'mastra-thread', resourceId: 'factory-1' }] }));
  app.all('*', c => c.json({ mastra: true }));
  return { app, ui, harness, session, fake, storage };
}

function nextEnd(session: ClaudeCodeSession): Promise<AgentRunEndReason | undefined> {
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

/** Reads SSE `data:` frames until `until` matches one. */
async function openStream(app: Hono, path = `${BASE}/card-1/stream`) {
  const controller = new AbortController();
  const response = await app.request(path, { signal: controller.signal });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const events: Array<Record<string, unknown>> = [];
  let buffer = '';
  const close = () => {
    controller.abort();
    void reader.cancel().catch(() => {});
  };
  open.push(close);
  return {
    response,
    events,
    close,
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

describe('Claude Code session routes', () => {
  it('answers session creation for a Claude session and passes any other session to Mastra', async () => {
    const { app } = await setup([]);
    const created = await post(app, BASE, { sessionId: 'card-1', resourceId: 'factory-1', threadId: 'card-1' });
    expect(await created.json()).toEqual({ controllerId: 'code', sessionId: 'card-1', resourceId: 'factory-1', threadId: 'card-1' });

    const mastra = await post(app, BASE, { sessionId: 'mastra-1', resourceId: 'owner' });
    expect(await mastra.json()).toEqual({ mastra: true });
    expect(await (await app.request('/api/agent-controller/other/sessions/card-1')).json()).toEqual({ mastra: true });
  });

  it('reports the session state the chat hydrates from', async () => {
    const { app } = await setup([]);
    const state = await (await app.request(`${BASE}/card-1?threadId=card-1`)).json();
    expect(state).toMatchObject({
      controllerId: 'code',
      sessionId: 'card-1',
      resourceId: 'factory-1',
      threadId: 'card-1',
      running: false,
      tasks: [],
      settings: { yolo: false, notifications: 'off', smartEditing: true },
    });
    expect((await app.request(`${BASE}/card-1?threadId=elsewhere`)).status).toBe(404);
  });

  it('delivers a chat message as a user turn and serves the recorded history', async () => {
    const { app, session, fake } = await setup([{ lines: fixture('turn-complete.jsonl') }]);
    const end = nextEnd(session);

    const sent = await post(app, `${BASE}/card-1/messages`, { message: 'Update the README.' });
    expect(await sent.json()).toEqual({ ok: true });
    expect(await end).toBe('complete');
    expect(fake.calls[0]!.stdin).toBe('Update the README.');

    const history = await app.request(`${BASE}/card-1/threads/card-1/messages?limit=100`);
    expect(history.status).toBe(200);
    const { messages } = (await history.json()) as { messages: Array<Record<string, any>> };
    expect(messages.map(message => message.role)).toEqual(['signal', 'assistant']);
    expect(messages[0]).toMatchObject({
      threadId: 'card-1',
      resourceId: 'factory-1',
      createdAt: expect.any(String),
      content: { parts: [{ type: 'text', text: 'Update the README.' }], metadata: { signal: { type: 'user' } } },
    });
    expect(messages[1]!.content.parts.map((part: { type: string }) => part.type)).toEqual(['reasoning', 'tool-invocation', 'text']);
    expect(messages[1]!.content.parts[1].toolInvocation).toMatchObject({ state: 'result', toolName: expect.any(String) });

    // The modern paging form answers the same messages with paging info.
    const paged = (await (await app.request(`${BASE}/card-1/threads/card-1/messages?perPage=false`)).json()) as Record<string, unknown>;
    expect((paged.messages as unknown[]).length).toBe(2);
    expect(paged).toHaveProperty('total');

    const threads = (await (await app.request(`${BASE}/card-1/threads`)).json()) as { threads: unknown[] };
    expect(threads.threads).toEqual([expect.objectContaining({ id: 'card-1', state: 'idle' })]);
  });

  it('streams the turn live: run start, messages, tool calls, run end', async () => {
    const { app } = await setup([{ lines: fixture('turn-complete.jsonl') }]);
    const stream = await openStream(app);
    expect(stream.response.headers.get('content-type')).toBe('text/event-stream');
    const first = await stream.until(() => true);
    expect(first).toMatchObject({ type: 'display_state_changed', displayState: { isRunning: false, pendingSuspensions: {} } });

    await post(app, `${BASE}/card-1/messages`, { message: 'Update the README.' });
    await stream.until(event => event.type === 'agent_end');
    const types = stream.events.map(event => event.type);
    expect(types[1]).toBe('agent_start');
    expect(types).toEqual(expect.arrayContaining(['message_start', 'message_update', 'tool_start', 'tool_end', 'message_end']));
    expect(types.at(-1)).toBe('agent_end');
    const userEcho = stream.events.find(event => event.type === 'message_start') as { message: Record<string, any> };
    expect(userEcho.message).toMatchObject({ role: 'signal', createdAt: expect.any(String) });
  });

  it('aborts the run in flight', async () => {
    const { app, session, fake } = await setup([{ lines: fixture('turn-complete.jsonl').slice(0, 2), hang: true }]);
    const stream = await openStream(app);
    await post(app, `${BASE}/card-1/messages`, { message: 'Take your time.' });
    await stream.until(event => event.type === 'agent_start');
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));

    const aborted = await post(app, `${BASE}/card-1/abort`);
    expect(await aborted.json()).toEqual({ ok: true });
    expect(await stream.until(event => event.type === 'agent_end')).toEqual({ type: 'agent_end', reason: 'aborted' });
    expect(session.run.isRunning()).toBe(false);
    expect(fake.calls[0]!.killed).toEqual(['SIGTERM']);
  });

  it('shows the submitted plan in history and resumes the session when the plan is approved from the chat', async () => {
    const { app, session, fake } = await setup([{ lines: fixture('turn-submit-plan.jsonl') }, { lines: fixture('turn-complete.jsonl') }], {
      mode: 'planning',
    });
    const parked = nextEnd(session);
    await post(app, `${BASE}/card-1/messages`, { message: 'Plan the README change.' });
    expect(await parked).toBe('suspended');

    const { messages } = (await (await app.request(`${BASE}/card-1/threads/card-1/messages?limit=100`)).json()) as {
      messages: Array<Record<string, any>>;
    };
    const assistant = messages.find(message => message.role === 'assistant')!;
    const card = assistant.content.parts.find((part: any) => part.toolInvocation?.toolName === 'submit_plan');
    expect(card.toolInvocation).toMatchObject({
      state: 'call',
      toolCallId: 'toolu_03Gate',
      args: { title: 'README usage section', plan: expect.stringContaining('usage section') },
    });
    expect(assistant.content.metadata.suspendedTools.toolu_03Gate).toMatchObject({ toolName: 'submit_plan' });

    const stream = await openStream(app);
    const state = await stream.until(() => true);
    expect(state).toMatchObject({
      displayState: { pendingSuspensions: { toolu_03Gate: { toolName: 'submit_plan', toolCallId: 'toolu_03Gate' } } },
    });

    expect(await (await post(app, `${BASE}/card-1/tool-suspension`, { toolCallId: 'toolu_other', resumeData: { action: 'approved' } })).json()).toEqual({
      ok: false,
      reason: 'stale_tool_call',
    });
    const resumed = nextEnd(session);
    const answered = await post(app, `${BASE}/card-1/tool-suspension`, { toolCallId: 'toolu_03Gate', resumeData: { action: 'approved' } });
    expect(await answered.json()).toEqual({ ok: true });
    expect(await resumed).toBe('complete');
    expect(fake.calls[1]!.stdin).toBe('The plan was approved. Implement it.');

    const after = (await (await app.request(`${BASE}/card-1/threads/card-1/messages?limit=100`)).json()) as {
      messages: Array<Record<string, any>>;
    };
    const settled = after.messages.flatMap(message => message.content.parts).find((part: any) => part.toolInvocation?.toolCallId === 'toolu_03Gate');
    expect(settled.toolInvocation).toMatchObject({ state: 'result', result: { action: 'approved', submittedPlan: { title: 'README usage section' } } });
    // The approval is the card's answer, not a message from the person.
    expect(after.messages.filter(message => message.role === 'signal')).toHaveLength(1);
  });

  it('asks the person in the chat when Claude needs permission, and resumes the session with their answer', async () => {
    const { app, session, fake } = await setup([{ lines: fixture('turn-permission.jsonl') }, { lines: fixture('turn-complete.jsonl') }]);
    const stream = await openStream(app);
    const parked = nextEnd(session);
    await post(app, `${BASE}/card-1/messages`, { message: 'Create an empty file x.txt.' });
    expect(await parked).toBe('suspended');
    const call = 'toolu_01EeMtJW2FWqSJ5sKMZmuQub';
    const input = { file_path: '/work/card-1/x.txt', content: '' };
    // The same event a Mastra session sends, so the chat draws its Allow / Deny card.
    expect(await stream.until(event => event.type === 'tool_approval_required')).toEqual({
      type: 'tool_approval_required',
      toolCallId: call,
      toolName: 'Write',
      args: input,
    });

    // A reload finds it in the history and in the state a new stream starts with.
    const { messages } = (await (await app.request(`${BASE}/card-1/threads/card-1/messages?limit=100`)).json()) as {
      messages: Array<Record<string, any>>;
    };
    const assistant = messages.find(message => message.role === 'assistant')!;
    expect(assistant.content.metadata.pendingToolApprovals[call]).toEqual({ toolCallId: call, toolName: 'Write', args: input });
    expect(assistant.content.parts[0].toolInvocation).toMatchObject({ state: 'call', toolCallId: call, toolName: 'Write' });
    const fresh = await openStream(app);
    expect(await fresh.until(() => true)).toMatchObject({
      displayState: { pendingApprovals: { [call]: { toolCallId: call, toolName: 'Write', args: input } } },
    });

    expect(await (await post(app, `${BASE}/card-1/tool-approval`, { toolCallId: 'toolu_other', approved: true })).json()).toEqual({
      ok: false,
      reason: 'stale_tool_call',
    });
    const resumed = nextEnd(session);
    expect(await (await post(app, `${BASE}/card-1/tool-approval`, { toolCallId: call, approved: true })).json()).toEqual({ ok: true });
    expect(await resumed).toBe('complete');
    expect(fake.calls[1]!.stdin).toContain('The person allowed `Write`');
    expect(fake.calls[1]!.args).toContain('--resume');

    const after = (await (await app.request(`${BASE}/card-1/threads/card-1/messages?limit=100`)).json()) as {
      messages: Array<Record<string, any>>;
    };
    const settled = after.messages.find(message => message.id === assistant.id)!;
    expect(settled.content.metadata?.pendingToolApprovals).toBeUndefined();
    expect(settled.content.parts[0].toolInvocation).toMatchObject({ state: 'result', toolCallId: call });
    expect(await (await post(app, `${BASE}/card-1/tool-approval`, { toolCallId: call, approved: true })).json()).toEqual({
      ok: false,
      reason: 'not_pending',
    });
  });

  it('shows a question Claude asks as the chat’s question card, and resumes the session with the answer', async () => {
    const { app, session, fake } = await setup([{ lines: fixture('turn-question.jsonl') }, { lines: fixture('turn-complete.jsonl') }]);
    const stream = await openStream(app);
    const parked = nextEnd(session);
    await post(app, `${BASE}/card-1/messages`, { message: 'Fix the bug.' });
    expect(await parked).toBe('suspended');
    const call = 'toolu_01EeMtJW2FWqSJ5sKMZmuQub';
    const question = {
      question: 'Which bug should be fixed?',
      options: [{ label: 'Frontend', description: 'A syncta_front bug.' }, { label: 'Backend' }],
      selectionMode: 'single_select',
    };
    // The event a Mastra `ask_user` sends, so the chat draws a question with options, not an Allow / Deny card.
    expect(await stream.until(event => event.type === 'tool_suspended')).toEqual({
      type: 'tool_suspended',
      toolCallId: call,
      toolName: 'ask_user',
      args: question,
      suspendPayload: question,
    });

    const { messages } = (await (await app.request(`${BASE}/card-1/threads/card-1/messages?limit=100`)).json()) as {
      messages: Array<Record<string, any>>;
    };
    const assistant = messages.find(message => message.role === 'assistant')!;
    expect(assistant.content.parts[0].toolInvocation).toMatchObject({ state: 'call', toolName: 'ask_user', args: question });
    expect(assistant.content.metadata.suspendedTools[call]).toMatchObject({ toolName: 'ask_user', args: question });
    expect(assistant.content.metadata.pendingToolApprovals).toBeUndefined();
    const fresh = await openStream(app);
    const initial = (await fresh.until(() => true)) as { displayState: { pendingSuspensions: object; pendingApprovals: object } };
    expect(initial.displayState.pendingSuspensions).toMatchObject({ [call]: { toolName: 'ask_user', args: question } });
    expect(initial.displayState.pendingApprovals).toEqual({});

    expect((await post(app, `${BASE}/card-1/tool-suspension`, { toolCallId: call, resumeData: '' })).status).toBe(400);
    const resumed = nextEnd(session);
    expect(await (await post(app, `${BASE}/card-1/tool-suspension`, { toolCallId: call, resumeData: 'Backend' })).json()).toEqual({
      ok: true,
    });
    expect(await resumed).toBe('complete');
    expect(fake.calls[1]!.stdin).toContain('Their answer:\nBackend');

    const after = (await (await app.request(`${BASE}/card-1/threads/card-1/messages?limit=100`)).json()) as {
      messages: Array<Record<string, any>>;
    };
    const settled = after.messages.find(message => message.id === assistant.id)!;
    expect(settled.content.metadata?.suspendedTools).toBeUndefined();
    expect(settled.content.parts[0].toolInvocation).toMatchObject({ state: 'result', toolName: 'ask_user', result: 'Backend' });
  });

  it('tells the host who answered or wrote, before the session acts on it', async () => {
    const { app, ui, session } = await setup([{ lines: fixture('turn-permission.jsonl') }, { lines: fixture('turn-complete.jsonl') }]);
    const seen: Array<{ user: unknown; sessionId: string; running: boolean }> = [];
    ui.setPersonInputHook((c, target) => {
      seen.push({ user: c.get('factoryAuthUser' as never), sessionId: target.id, running: target.run.isRunning() });
    });
    const parked = nextEnd(session);
    expect((await post(app, `${BASE}/card-1/messages`, { message: 'Create x.txt' })).status).toBe(200);
    await parked;
    const call = session.pendingPermission!.toolCallId;
    const resumed = nextEnd(session);
    await post(app, `${BASE}/card-1/tool-approval`, { toolCallId: call, approved: false });
    await resumed;
    expect(seen).toEqual([
      { user: OWNER, sessionId: 'card-1', running: false },
      { user: OWNER, sessionId: 'card-1', running: false },
    ]);
  });

  it('keeps another person’s private session out of reach', async () => {
    const { app } = await setup([], { user: { workosId: 'someone-else', organizationId: 'org-1' }, visibility: 'private' });
    expect((await app.request(`${BASE}/card-1/threads/card-1/messages?limit=10`)).status).toBe(404);
    expect((await post(app, `${BASE}/card-1/messages`, { message: 'hi' })).status).toBe(404);
  });

  it('lists the Claude runs in flight with the controller’s', async () => {
    const { app } = await setup([{ lines: fixture('turn-complete.jsonl').slice(0, 2), hang: true }]);
    const stream = await openStream(app);
    await post(app, `${BASE}/card-1/messages`, { message: 'Go' });
    await stream.until(event => event.type === 'agent_start');
    const { runs } = (await (await app.request('/api/agent-controller/code/active-runs')).json()) as { runs: Array<Record<string, unknown>> };
    expect(runs).toEqual([
      { runId: 'mastra-run', threadId: 'mastra-thread', resourceId: 'factory-1' },
      { runId: expect.any(String), threadId: 'card-1', resourceId: 'factory-1' },
    ]);
    await post(app, `${BASE}/card-1/abort`);
  });

  it('answers what a Claude session has no counterpart for without reaching Mastra', async () => {
    const { app } = await setup([]);
    expect(await (await app.request(`${BASE}/card-1/permissions`)).json()).toEqual({ categories: {}, tools: {} });
    const switched = await post(app, `${BASE}/card-1/model`, { modelId: 'openai/gpt-5' });
    expect(switched.status).toBe(409);
    expect(await switched.json()).toEqual({ error: 'Claude Code sessions do not support POST /model.' });
    const withFiles = await post(app, `${BASE}/card-1/messages`, { message: 'look', files: [{ data: 'x', mediaType: 'image/png' }] });
    expect(withFiles.status).toBe(400);
  });
});
