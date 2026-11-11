import { describe, expect, it } from 'vitest';

import type { AgentEvent } from '@factory/harness';
import type { TranscriptEntry } from '@factory/harness/transcript';

import { createCodexHarness } from './harness.ts';
import type { CodexSession, CodexSessionConfig } from './session.ts';
import { createInMemoryCodexSessionStore } from './store.ts';
import { FakeCodexAppServer, fakeCodexSpawn } from './testkit.ts';
import { CodexRunContext } from './harness.ts';
import { CodexError } from './errors.ts';
import { CODEX_ACCOUNT_SWITCH_PROMPT } from './session.ts';

const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(check: () => boolean, label = 'condition') {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await tick();
  }
  throw new Error(`Timed out waiting for ${label}`);
}

type Script = (server: FakeCodexAppServer, turn: { threadId: string; turnId: string; params: any }) => void | Promise<void>;

/** A fake whose turns run `scripts` in order (the last one repeats). */
function scripted(scripts: Script[]) {
  let turns = 0;
  return fakeCodexSpawn(server => {
    server.handle('turn/start', params => {
      const turnId = `turn-${++turns}`;
      const script = scripts[Math.min(turns, scripts.length) - 1]!;
      setImmediate(() => {
        server.notify('turn/started', { threadId: params.threadId, turn: { id: turnId, status: 'inProgress' } });
        void script(server, { threadId: params.threadId, turnId, params });
      });
      return { turn: { id: turnId, status: 'inProgress', items: [] } };
    });
  });
}

const reply =
  (text: string, usage = true): Script =>
  (server, { threadId, turnId }) => {
    server.notify('item/agentMessage/delta', { threadId, turnId, itemId: `msg-${turnId}`, delta: text });
    server.notify('item/completed', { threadId, turnId, item: { type: 'agentMessage', id: `msg-${turnId}`, text } });
    if (usage) {
      const breakdown = { inputTokens: 100, cachedInputTokens: 40, outputTokens: 20, reasoningOutputTokens: 5, totalTokens: 120 };
      server.notify('thread/tokenUsage/updated', { threadId, turnId, tokenUsage: { total: breakdown, last: breakdown } });
    }
    server.notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } });
  };

async function harnessWith(spawn: ReturnType<typeof fakeCodexSpawn>, config: Partial<CodexSessionConfig> = {}) {
  const store = createInMemoryCodexSessionStore();
  const harness = createCodexHarness({ store, spawn, cwdFor: () => '/work/repo', env: { PATH: '/bin', HOME: '/home/me', SECRET_TOKEN: 'x' }, ...config });
  const session = await harness.createSession({ sessionId: 's1', threadId: 's1', resourceId: 'r1' });
  const events: AgentEvent[] = [];
  const transcript: TranscriptEntry[] = [];
  session.subscribe(event => events.push(event));
  session.onTranscript(entry => transcript.push(entry));
  return { harness, session, store, events, transcript };
}

const ended = (events: AgentEvent[]) => events.filter((event): event is Extract<AgentEvent, { type: 'agent_end' }> => event.type === 'agent_end');

describe('CodexSession', () => {
  it('runs a turn: opens the thread with its instructions and MCP servers, sends the model and streams the reply', async () => {
    const spawn = scripted([reply('Done.')]);
    const { session, events, transcript, store } = await harnessWith(spawn, {
      developerInstructions: 'You are a Factory agent.',
      mcpServersFor: async () => ({ factory: { url: 'http://factory/mcp', http_headers: { 'x-token': 't' } } }),
      turnSelectionFor: async () => ({ model: 'gpt-test-sol', effort: 'high', serviceTier: 'priority' }),
      turnContextFor: async () => '<factory-environment>repo</factory-environment>',
    });

    const result = await session.sendMessage({ content: 'Fix the bug', requestContext: new CodexRunContext().set('mastra__messageAuthor', { id: 'u1', name: 'Ann' }) });
    expect(result).toEqual({ reason: 'complete' });

    expect(spawn.calls[0]).toMatchObject({ command: 'codex', args: ['app-server'], cwd: '/work/repo', env: { PATH: '/bin', HOME: '/home/me' } });
    expect(spawn.calls[0]!.env).not.toHaveProperty('SECRET_TOKEN');
    const server = spawn.servers[0]!;
    expect(server.requests('thread/start')[0]!.params).toMatchObject({
      cwd: '/work/repo',
      developerInstructions: 'You are a Factory agent.',
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      model: 'gpt-test-sol',
      config: {
        'tools.update_plan.enabled': true,
        'mcp_servers.factory': { url: 'http://factory/mcp', http_headers: { 'x-token': 't' }, tool_timeout_sec: 3900 },
      },
    });
    expect(server.requests('turn/start')[0]!.params).toMatchObject({
      threadId: 'thread-1',
      input: [{ type: 'text', text: '<factory-environment>repo</factory-environment>\n\nFix the bug' }],
      model: 'gpt-test-sol',
      effort: 'high',
      serviceTier: 'priority',
      summary: 'detailed',
      approvalPolicy: 'on-request',
      sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
      collaborationMode: { mode: 'default', settings: { model: 'gpt-test-sol', reasoning_effort: 'high' } },
    });

    expect(transcript).toEqual([
      { kind: 'input', source: 'signal', text: 'Fix the bug', author: { id: 'u1', name: 'Ann' } },
      { kind: 'init', sessionId: 'thread-1', model: 'gpt-test-sol' },
      { kind: 'text_delta', text: 'Done.' },
      { kind: 'text', text: 'Done.', messageId: 'msg-turn-1' },
    ]);
    expect(events.map(event => event.type)).toEqual(['usage_update', 'agent_end']);
    expect(events[0]).toEqual({
      type: 'usage_update',
      usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, cachedInputTokens: 40, reasoningTokens: 5 },
    });
    expect(session.codexThreadId).toBe('thread-1');
    expect((await store.get('s1'))!.threads.s1!.codexThreadId).toBe('thread-1');
    // The process ends with the run.
    await until(() => server.closed, 'process end');
  });

  it('resumes its Codex thread on the next run and starts a fresh one when Codex lost it', async () => {
    const spawn = scripted([reply('One.', false)]);
    const { session } = await harnessWith(spawn);
    await session.sendMessage({ content: 'first' });
    await session.sendMessage({ content: 'second' });
    expect(spawn.servers[1]!.requests('thread/resume')[0]!.params).toMatchObject({ threadId: 'thread-1', cwd: '/work/repo' });
    expect(spawn.servers[1]!.requests('thread/start')).toEqual([]);

    // Codex lost the thread (its home was cleared): the turn goes on in a new one.
    const fresh = scripted([reply('Two.', false)]);
    const original = fresh as unknown as (...args: unknown[]) => unknown;
    const losing = Object.assign((...args: unknown[]) => {
      const child = original(...args);
      fresh.servers.at(-1)!.handle('thread/resume', () => {
        throw new Error('no rollout found for thread');
      });
      return child;
    }, { servers: fresh.servers, calls: fresh.calls }) as unknown as typeof fresh;
    const second = await harnessWith(losing);
    await second.session.sendMessage({ content: 'first' });
    await second.session.sendMessage({ content: 'second' });
    expect(fresh.servers[1]!.requests('thread/resume')).toHaveLength(1);
    expect(fresh.servers[1]!.requests('thread/start')).toHaveLength(1);
    expect(second.session.codexThreadId).toBe('thread-1');
  });

  it('queues input that arrives mid-turn as the next turn of the same run', async () => {
    let release!: () => void;
    const spawn = scripted([
      async (server, turn) => {
        await new Promise<void>(resolve => (release = resolve));
        reply('First.', false)(server, turn);
      },
      reply('Second.', false),
    ]);
    const { session, transcript, events } = await harnessWith(spawn);
    const first = session.sendMessage({ content: 'one' });
    await until(() => typeof release === 'function', 'turn');
    await session.sendChatMessage({ content: 'two' });
    release();
    expect(await first).toEqual({ reason: 'complete' });
    expect(spawn.servers).toHaveLength(1);
    expect(spawn.servers[0]!.requests('turn/start').map(message => (message.params as any).input[0].text)).toEqual(['one', 'two']);
    expect(transcript.filter(entry => entry.kind === 'input')).toEqual([
      { kind: 'input', source: 'signal', text: 'one' },
      { kind: 'input', source: 'signal', text: 'two', delivery: 'while-active' },
    ]);
    expect(ended(events)).toEqual([{ type: 'agent_end', reason: 'complete' }]);
  });

  it('parks on a command approval and resumes the same turn with the answer', async () => {
    let answer: unknown;
    const spawn = scripted([
      async (server, { threadId, turnId }) => {
        const reply1 = await server.request('item/commandExecution/requestApproval', { threadId, turnId, itemId: 'cmd-1', command: 'rm -rf build', cwd: '/work/repo' });
        answer = reply1.result;
        server.notify('item/started', { threadId, turnId, item: { type: 'commandExecution', id: 'cmd-1', command: 'rm -rf build', cwd: '/work/repo', status: 'inProgress' } });
        server.notify('item/completed', { threadId, turnId, item: { type: 'commandExecution', id: 'cmd-1', command: 'rm -rf build', cwd: '/work/repo', status: 'completed', aggregatedOutput: 'removed', exitCode: 0 } });
        reply('Cleaned.', false)(server, { threadId, turnId, params: {} });
      },
    ]);
    const { session, events, transcript } = await harnessWith(spawn);
    expect(await session.sendMessage({ content: 'clean' })).toEqual({ reason: 'suspended' });
    expect(events).toEqual([
      { type: 'tool_suspended', toolName: 'execute_command', toolCallId: 'cmd-1' },
      { type: 'agent_end', reason: 'suspended' },
    ]);
    expect(session.pendingPermission).toEqual({ toolCallId: 'cmd-1', toolName: 'execute_command', input: { command: 'rm -rf build', cwd: '/work/repo' } });
    expect(session.suspensions.hasPending()).toBe(true);
    expect(session.hasLiveGate).toBe(true);
    expect(transcript.slice(2)).toEqual([
      { kind: 'tool_call', toolCallId: 'cmd-1', toolName: 'execute_command', input: { command: 'rm -rf build', cwd: '/work/repo' } },
      { kind: 'permission', toolCallId: 'cmd-1', toolName: 'execute_command', input: { command: 'rm -rf build', cwd: '/work/repo' } },
    ]);

    await session.respondToToolApproval({ approved: true, toolCallId: 'cmd-1' });
    await until(() => ended(events).length === 2, 'resumed run');
    expect(answer).toEqual({ decision: 'acceptForSession' });
    expect(ended(events).at(-1)).toEqual({ type: 'agent_end', reason: 'complete' });
    expect(spawn.servers).toHaveLength(1);
    expect(session.grantedTools).toEqual(['execute_command']);
    expect(transcript.slice(4)).toEqual([
      { kind: 'permission_decision', toolCallId: 'cmd-1', toolName: 'execute_command', approved: true },
      { kind: 'tool_call', toolCallId: 'cmd-1:0:run', toolName: 'execute_command', input: { command: 'rm -rf build', cwd: '/work/repo' } },
      { kind: 'tool_result', toolCallId: 'cmd-1:0:run', content: 'removed\n\nExit code 0', isError: false },
      { kind: 'text_delta', text: 'Cleaned.' },
      { kind: 'text', text: 'Cleaned.', messageId: 'msg-turn-1' },
    ]);
  });

  it('answers a parked approval in a new turn once its process is gone', async () => {
    const spawn = scripted([
      async (server, { threadId, turnId }) => {
        await server.request('item/fileChange/requestApproval', { threadId, turnId, itemId: 'patch-1', reason: 'Needs to write' });
      },
      reply('Skipped it.', false),
    ]);
    const { session, events } = await harnessWith(spawn);
    expect(await session.sendMessage({ content: 'edit' })).toEqual({ reason: 'suspended' });
    spawn.servers[0]!.emit('exit', 1);
    await until(() => !session.hasLiveGate, 'process exit');
    await session.respondToToolApproval({ approved: false });
    await until(() => ended(events).length === 2, 'next run');
    expect(spawn.servers).toHaveLength(2);
    const prompt = (spawn.servers[1]!.requests('turn/start')[0]!.params as any).input[0].text as string;
    expect(prompt).toContain('denied permission');
    expect(session.grantedTools).toEqual([]);
  });

  it('auto-accepts a call a person allowed for the session, and refuses asks on an unattended card run', async () => {
    const answers: unknown[] = [];
    const ask: Script = async (server, { threadId, turnId }) => {
      answers.push((await server.request('item/commandExecution/requestApproval', { threadId, turnId, itemId: `cmd-${turnId}`, command: 'ls' })).result);
      reply('ok', false)(server, { threadId, turnId, params: {} });
    };
    const spawn = scripted([ask]);
    const unattended = await harnessWith(spawn, { policyFor: async () => ({ unattended: true }) });
    expect(await unattended.session.sendMessage({ content: 'go' })).toEqual({ reason: 'complete' });
    expect(answers).toEqual([{ decision: 'decline' }]);
    expect((spawn.servers[0]!.requests('turn/start')[0]!.params as any).approvalPolicy).toBe('never');

    const spawn2 = scripted([ask]);
    const attended = await harnessWith(spawn2);
    await attended.session.sendMessage({ content: 'go' });
    await attended.session.respondToToolApproval({ approved: true });
    await until(() => ended(attended.events).length === 2, 'resumed');
    await attended.session.sendMessage({ content: 'again' });
    expect(answers.slice(1)).toEqual([{ decision: 'acceptForSession' }, { decision: 'acceptForSession' }]);
    expect(ended(attended.events).map(event => event.reason)).toEqual(['suspended', 'complete', 'complete']);
  });

  it('parks a question and gives Codex the answer', async () => {
    let answers: unknown;
    const spawn = scripted([
      async (server, { threadId, turnId }) => {
        const response = await server.request('item/tool/requestUserInput', {
          threadId,
          turnId,
          itemId: 'q-1',
          questions: [{ id: 'db', header: 'Database', question: 'Which database?', options: [{ label: 'Postgres', description: 'SQL' }, { label: 'SQLite', description: '' }] }],
        });
        answers = response.result;
        reply('Using Postgres.', false)(server, { threadId, turnId, params: {} });
      },
    ]);
    const { session, events, transcript } = await harnessWith(spawn);
    expect(await session.sendMessage({ content: 'set up storage' })).toEqual({ reason: 'suspended' });
    expect(session.pendingPermission?.toolName).toBe('AskUserQuestion');
    expect(transcript.find(entry => entry.kind === 'tool_call')).toMatchObject({
      toolName: 'AskUserQuestion',
      input: { questions: [{ id: 'db', question: 'Which database?', header: 'Database', options: [{ label: 'Postgres', description: 'SQL' }, { label: 'SQLite' }] }] },
    });
    await expect(session.respondToToolApproval({ approved: true })).rejects.toThrow('question');
    await session.answerQuestion({ answer: 'Postgres', toolCallId: 'q-1' });
    await until(() => ended(events).length === 2, 'answered');
    expect(answers).toEqual({ answers: { db: { answers: ['Postgres'] } } });
    expect(transcript).toContainEqual({ kind: 'question_answer', toolCallId: 'q-1', answer: 'Postgres' });
  });

  it('cancels a parked approval when new input comes first', async () => {
    let answer: unknown;
    const spawn = scripted([
      async (server, { threadId, turnId }) => {
        answer = (await server.request('item/commandExecution/requestApproval', { threadId, turnId, itemId: 'cmd-1', command: 'make' })).result;
      },
      reply('Something else.', false),
    ]);
    const { session, events } = await harnessWith(spawn);
    await session.sendMessage({ content: 'build' });
    await session.sendMessage({ content: 'never mind' });
    expect(events).toContainEqual({ type: 'tool_suspension_cancelled', toolCallId: 'cmd-1' });
    expect(answer).toEqual({ decision: 'cancel' });
    expect(session.pendingPermission).toBeUndefined();
    expect(spawn.servers[0]!.closed).toBe(true);
  });

  it('plans read-only in plan mode, parks on the plan, and implements it once approved', async () => {
    const spawn = scripted([
      (server, { threadId, turnId }) => {
        server.notify('item/completed', { threadId, turnId, item: { type: 'plan', id: 'plan-1', text: '# Add caching\n\n1. Do it' } });
        server.notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } });
      },
      reply('Implemented.', false),
    ]);
    const { session, events, transcript } = await harnessWith(spawn, {
      mode: 'planning',
      turnSelectionFor: async () => ({ model: 'gpt-test-sol' }),
    });
    expect(await session.sendMessage({ content: 'add caching' })).toEqual({ reason: 'suspended' });
    const turn = spawn.servers[0]!.requests('turn/start')[0]!.params as any;
    expect(turn.collaborationMode).toEqual({ mode: 'plan', settings: { model: 'gpt-test-sol' } });
    expect(turn.sandboxPolicy).toEqual({ type: 'readOnly', networkAccess: false });
    expect(turn.input[0].text).toMatch(/^You are planning\./);
    const gate = session.pendingPlan!;
    expect(gate).toEqual({ toolCallId: 'plan-1:submit_plan', toolName: 'submit_plan', plan: '# Add caching\n\n1. Do it', title: 'Add caching' });
    expect(events).toContainEqual({ type: 'tool_suspended', toolName: 'submit_plan', toolCallId: 'plan-1:submit_plan' });
    expect(transcript.filter(entry => entry.kind === 'tool_call' || entry.kind === 'plan')).toEqual([
      { kind: 'tool_call', toolCallId: 'plan-1:submit_plan', toolName: 'submit_plan', input: { plan: '# Add caching\n\n1. Do it', title: 'Add caching' } },
      { kind: 'plan', ...gate },
    ]);

    await session.respondToToolSuspension({ resumeData: { action: 'approved', feedback: 'Keep it small' } });
    await until(() => ended(events).length === 2, 'implementation');
    expect(session.mode).toBe('default');
    const next = spawn.servers[1]!.requests('turn/start')[0]!.params as any;
    expect(next.collaborationMode.mode).toBe('default');
    expect(next.input[0].text).toBe('The plan was approved. Implement it.\n\nReviewer notes:\nKeep it small');
    expect(transcript).toContainEqual({ kind: 'plan_decision', toolCallId: 'plan-1:submit_plan', decision: { action: 'approved', feedback: 'Keep it small' } });
  });

  it('interrupts the turn on abort', async () => {
    const spawn = scripted([() => {}]);
    const { session, events } = await harnessWith(spawn);
    const running = session.sendMessage({ content: 'long job' });
    await until(() => spawn.servers[0]?.requests('turn/start').length === 1, 'turn start');
    await tick();
    session.abort();
    expect(await running).toEqual({ reason: 'aborted' });
    expect(ended(events)).toEqual([{ type: 'agent_end', reason: 'aborted' }]);
    await until(() => spawn.servers[0]!.requests('turn/interrupt').length === 1, 'interrupt');
    expect(spawn.servers[0]!.requests('turn/interrupt')[0]!.params).toEqual({ threadId: 'thread-1', turnId: 'turn-1' });
  });

  it('fails a turn Codex failed, as a usage limit with when it resets', async () => {
    const spawn = scripted([
      (server, { threadId, turnId }) => {
        server.notify('account/rateLimits/updated', { rateLimits: { limitId: 'codex', primary: { usedPercent: 100, resetsAt: 1_800_000_000 } } });
        server.notify('error', { threadId, turnId, willRetry: false, error: { message: 'You hit your usage limit.', codexErrorInfo: 'usageLimitExceeded' } });
        server.notify('turn/completed', { threadId, turn: { id: turnId, status: 'failed', error: { message: 'usage limit' } } });
      },
    ]);
    const { session, events } = await harnessWith(spawn);
    expect(await session.sendMessage({ content: 'go' })).toEqual({ reason: 'error' });
    const error = (events.find(event => event.type === 'error') as { error: any }).error;
    expect(error).toMatchObject({ _tag: 'CodexError', kind: 'rate_limit', code: 'usageLimitExceeded', message: 'You hit your usage limit.' });
    expect(error.resetsAt.toISOString()).toBe('2027-01-15T08:00:00.000Z');
  });

  it('fails the run when the app-server dies mid-turn', async () => {
    const spawn = scripted([server => { server.emit('exit', 1); }]);
    const { session, events } = await harnessWith(spawn);
    expect(await session.sendMessage({ content: 'go' })).toEqual({ reason: 'error' });
    expect(events.find(event => event.type === 'error')).toMatchObject({ error: { kind: 'process' } });
  });

  it('keeps the dispatcher signal undelivered until Codex took it, and wraps a skill kickoff', async () => {
    const spawn = scripted([reply('ok', false)]);
    const { session } = await harnessWith(spawn);
    const { accepted } = session.sendSignal(
      { id: 'sig-1', type: 'reactive', tagName: 'skill', attributes: { name: 'build' }, contents: 'Do </skill> it' },
      { requestContext: new CodexRunContext(), requireDelivery: true },
    );
    await expect(accepted).resolves.toMatchObject({ accepted: true, action: 'wake' });
    await until(() => !session.run.isRunning(), 'run end');
    expect(await session.thread.listActiveMessages()).toEqual([{ id: 'sig-1' }]);
    expect((spawn.servers[0]!.requests('turn/start')[0]!.params as any).input[0].text).toBe('<skill name="build">\nDo &lt;/skill&gt; it\n</skill>');
  });

  it('holds a low notification for the next run and wakes an idle session for an urgent one', async () => {
    const spawn = scripted([reply('ok', false)]);
    const { session } = await harnessWith(spawn);
    await session.sendNotificationSignal({ source: 'github', kind: 'ci', summary: 'CI is slow', priority: 'low' }, { ifIdle: { behavior: 'wake' } });
    expect(spawn.servers).toHaveLength(0);
    const urgent = await session.sendNotificationSignal({ source: 'github', kind: 'ci', summary: 'CI failed', priority: 'urgent' }, { ifIdle: { behavior: 'wake' } });
    await expect(urgent.accepted).resolves.toMatchObject({ action: 'wake' });
    await until(() => !session.run.isRunning(), 'run end');
    const text = (spawn.servers[0]!.requests('turn/start')[0]!.params as any).input[0].text as string;
    expect(text).toContain('<system-notification source="github" kind="ci" priority="low">\nCI is slow');
    expect(text).toContain('priority="urgent">\nCI failed');
  });
});

describe('createCodexHarness', () => {
  it('rehydrates a stored session once and lists runs in flight', async () => {
    const spawn = scripted([() => {}]);
    const store = createInMemoryCodexSessionStore();
    const seen: CodexSession[] = [];
    const harness = createCodexHarness({ store, spawn, cwdFor: () => '/work', env: {}, onSession: session => seen.push(session) });
    await harness.createSession({ sessionId: 's1', threadId: 't1', resourceId: 'r1' });
    const [a, b] = await Promise.all([harness.getSession('s1'), harness.getSession('s1')]);
    expect(a).toBe(b);
    expect(seen).toHaveLength(1);
    expect(await harness.getSession('missing')).toBeUndefined();
    void a!.sendMessage({ content: 'go' });
    await until(() => a!.run.isRunning(), 'run');
    expect(harness.listActiveThreadRuns()).toEqual([{ threadId: 't1', runId: a!.runId, resourceId: 'r1' }]);
    await harness.deleteSession('s1');
    expect(a!.run.isRunning()).toBe(false);
    const context = harness.runContext(a!, { userId: 'u', orgId: 'o', threadId: 't1', resourceId: 'r1' });
    expect(context.get('controller')).toMatchObject({ session: { id: 's1' } });
  });

  describe('accounts', () => {
    const tokens = (id: string) => ({ accessToken: `at-${id}`, chatgptAccountId: `ws-${id}`, planType: 'plus' });
    const limited: Script = (server, { threadId, turnId }) => {
      server.notify('error', { threadId, turnId, willRetry: false, error: { message: 'You hit your usage limit.', codexErrorInfo: 'usageLimitExceeded' } });
      server.notify('turn/completed', { threadId, turn: { id: turnId, status: 'failed', error: { message: 'usage limit' } } });
    };

    it('signs the run in with the host’s tokens alone, in the session’s own home, and refreshes them when Codex asks', async () => {
      const spawn = scripted([
        async (server, turn) => {
          const answer = await server.request('account/chatgptAuthTokens/refresh', { reason: 'unauthorized', previousAccountId: 'ws-a' });
          expect(answer.result).toEqual({ accessToken: 'at-a2', chatgptAccountId: 'ws-a', chatgptPlanType: 'plus' });
          reply('Done.')(server, turn);
        },
      ]);
      const requests: unknown[] = [];
      const refreshed: unknown[] = [];
      const { session, transcript, store } = await harnessWith(spawn, {
        codexHomeFor: () => '/homes/s1',
        credentials: async (_session, request) => {
          requests.push(request);
          return { tokens: tokens('a'), accountId: 'acc-a', credential: { label: 'alice@example.com', ownerId: 'u1' } };
        },
        refreshCredentials: async (_session, input) => {
          refreshed.push(input);
          return { ...tokens('a'), accessToken: 'at-a2' };
        },
      });

      expect(await session.sendMessage({ content: 'Fix it' })).toEqual({ reason: 'complete' });
      expect(spawn.calls[0]!.env).toMatchObject({ CODEX_HOME: '/homes/s1' });
      expect(spawn.servers[0]!.requests('account/login/start')[0]!.params).toEqual({
        type: 'chatgptAuthTokens',
        accessToken: 'at-a',
        chatgptAccountId: 'ws-a',
        chatgptPlanType: 'plus',
      });
      expect(requests).toEqual([{ exclude: [] }]);
      expect(refreshed).toEqual([{ accountId: 'acc-a', accessToken: 'at-a' }]);
      expect(transcript).toContainEqual({ kind: 'credential', label: 'alice@example.com', ownerId: 'u1' });
      expect((await store.get('s1'))?.accountId).toBe('acc-a');

      // The next run prefers the account the session ran on.
      await session.sendMessage({ content: 'Again' });
      expect(requests[1]).toEqual({ preferredAccountId: 'acc-a', exclude: [] });
    });

    it('moves a turn that ran out of usage to the next account, in the same thread, and tells Codex to go on', async () => {
      const spawn = scripted([limited, reply('Done.')]);
      const failures: Array<{ accountId: string; kind: string }> = [];
      const { session, transcript } = await harnessWith(spawn, {
        credentials: async (_session, request) =>
          request.exclude.includes('acc-a')
            ? { tokens: tokens('b'), accountId: 'acc-b', credential: { label: 'b' } }
            : { tokens: tokens('a'), accountId: 'acc-a', credential: { label: 'a' } },
        onCredentialFailure: async (_session, failure) => {
          failures.push({ accountId: failure.accountId, kind: failure.error.kind });
        },
      });

      expect(await session.sendMessage({ content: 'Fix it' })).toEqual({ reason: 'complete' });
      const server = spawn.servers[0]!;
      expect(spawn.servers).toHaveLength(1);
      expect(failures).toEqual([{ accountId: 'acc-a', kind: 'rate_limit' }]);
      expect(server.requests('account/login/start').map(message => (message.params as { accessToken: string }).accessToken)).toEqual(['at-a', 'at-b']);
      const turns = server.requests('turn/start').map(message => (message.params as { input: Array<{ text: string }> }).input[0]!.text);
      expect(turns[0]).toContain('Fix it');
      expect(turns[1]).toBe(CODEX_ACCOUNT_SWITCH_PROMPT);
      expect(transcript.filter(entry => entry.kind === 'credential')).toEqual([
        { kind: 'credential', label: 'a' },
        { kind: 'credential', label: 'b' },
      ]);
    });

    it('ends the turn with the hook’s error when no other account is left', async () => {
      const spawn = scripted([limited]);
      const { session, events } = await harnessWith(spawn, {
        credentials: async (_session, request) => {
          if (request.exclude.length) throw new CodexError('rate_limit', 'Every ChatGPT account is out of usage.');
          return { tokens: tokens('a'), accountId: 'acc-a' };
        },
      });
      expect(await session.sendMessage({ content: 'Fix it' })).toEqual({ reason: 'error' });
      const error = events.find(event => event.type === 'error') as { error: CodexError } | undefined;
      expect(error?.error).toMatchObject({ kind: 'rate_limit', message: 'Every ChatGPT account is out of usage.' });
    });
  });

  it('parks an MCP tool call Codex asks to allow, and an ask-each-time tool’s Allow covers that call alone', async () => {
    const answers: unknown[] = [];
    const ask: Script = async (server, { threadId, turnId }) => {
      const reply1 = await server.request('mcpServer/elicitation/request', {
        threadId,
        turnId,
        serverName: 'factory',
        mode: 'form',
        message: 'Allow factory to retry the decision?',
        _meta: { codex_approval_kind: 'mcp_tool_call', tool_name: 'factory_retry_decision' },
      });
      answers.push(reply1.result);
      reply('Retried.', false)(server, { threadId, turnId, params: {} });
    };
    const spawn = scripted([ask]);
    const { session, events } = await harnessWith(spawn, { policyFor: async () => ({ askEachTime: ['mcp__factory__factory_retry_decision'] }) });
    expect(await session.sendMessage({ content: 'retry it' })).toEqual({ reason: 'suspended' });
    expect(session.pendingPermission).toMatchObject({
      toolName: 'mcp__factory__factory_retry_decision',
      input: { reason: 'Allow factory to retry the decision?' },
      once: true,
    });
    await session.respondToToolApproval({ approved: true });
    await until(() => ended(events).length === 2, 'resumed run');
    expect(answers).toEqual([{ action: 'accept', content: null, _meta: null }]);
    expect(session.grantedTools).toEqual([]);

    // Any other elicitation (a form) is declined.
    const other = scripted([
      async (server, { threadId, turnId }) => {
        answers.push((await server.request('mcpServer/elicitation/request', { threadId, turnId, serverName: 'x', mode: 'form', message: 'Name?', _meta: null })).result);
        reply('ok', false)(server, { threadId, turnId, params: {} });
      },
    ]);
    const plain = await harnessWith(other);
    expect(await plain.session.sendMessage({ content: 'go' })).toEqual({ reason: 'complete' });
    expect(answers.at(-1)).toEqual({ action: 'decline' });
  });
});
