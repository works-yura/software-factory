// End-to-end flows of a Codex session against the fake app-server: question cards, MCP forms,
// subagents, steering, generated images, and an account switch after a parked approval.
import { describe, expect, it } from 'vitest';

import type { AgentEvent } from '@factory/harness';
import type { TranscriptEntry } from '@factory/harness/transcript';

import { CodexError } from './errors.ts';
import { createCodexHarness } from './harness.ts';
import { CODEX_ACCOUNT_SWITCH_PROMPT, CODEX_THREAD_CONFIG, codexMcpToolApproval, type CodexSessionConfig } from './session.ts';
import { createInMemoryCodexSessionStore } from './store.ts';
import { type FakeCodexAppServer, fakeCodexSpawn } from './testkit.ts';

const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(check: () => boolean, label = 'condition') {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await tick();
  }
  throw new Error(`Timed out waiting for ${label}`);
}

type Script = (server: FakeCodexAppServer, turn: { threadId: string; turnId: string; params: any }) => void | Promise<void>;

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
  (text: string): Script =>
  (server, { threadId, turnId }) => {
    server.notify('item/completed', { threadId, turnId, item: { type: 'agentMessage', id: `msg-${turnId}`, text } });
    server.notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } });
  };

async function harnessWith(spawn: ReturnType<typeof fakeCodexSpawn>, config: Partial<CodexSessionConfig> = {}) {
  const store = createInMemoryCodexSessionStore();
  const harness = createCodexHarness({ store, spawn, cwdFor: () => '/work/repo', env: { PATH: '/bin', HOME: '/home/me' }, ...config });
  const session = await harness.createSession({ sessionId: 's1', threadId: 's1', resourceId: 'r1' });
  const events: AgentEvent[] = [];
  const transcript: TranscriptEntry[] = [];
  session.subscribe(event => events.push(event));
  session.onTranscript(entry => transcript.push(entry));
  return { harness, session, store, events, transcript };
}

const ended = (events: AgentEvent[]) => events.filter((event): event is Extract<AgentEvent, { type: 'agent_end' }> => event.type === 'agent_end');

/** A card's answers as the chat sends them (`formatQuestionAnswers`): each under its numbered question. */
const chatReply = (pairs: Array<[string, string]>) => pairs.map(([question, answer], index) => `${index + 1}. ${question}\n   → ${answer}`).join('\n');

describe('Codex session flows', () => {
  it('offers its question tool in every mode, not only in plan mode', async () => {
    const spawn = scripted([reply('ok')]);
    const { session } = await harnessWith(spawn);
    await session.sendMessage({ content: 'hi' });
    expect(CODEX_THREAD_CONFIG['features.default_mode_request_user_input']).toBe(true);
    expect((spawn.servers[0]!.requests('thread/start')[0]!.params as any).config).toMatchObject({ 'features.default_mode_request_user_input': true });
  });

  it('asks several questions on one card and gives each its own answer', async () => {
    let answers: unknown;
    const questions = [
      { id: 'db', header: 'Database', question: 'Which database?', options: [{ label: 'Postgres (Recommended)', description: 'SQL' }, { label: 'SQLite', description: 'File' }] },
      { id: 'auth', header: 'Auth', question: 'Who signs in?', isOther: true, options: [{ label: 'Members', description: '' }, { label: 'Anyone', description: '' }] },
    ];
    const spawn = scripted([
      async (server, { threadId, turnId }) => {
        answers = (await server.request('item/tool/requestUserInput', { threadId, turnId, itemId: 'q-1', questions })).result;
        reply('Set up.')(server, { threadId, turnId, params: {} });
      },
    ]);
    const { session, events, transcript } = await harnessWith(spawn);
    expect(await session.sendMessage({ content: 'set it up' })).toEqual({ reason: 'suspended' });
    expect(events).toContainEqual({ type: 'tool_suspended', toolName: 'AskUserQuestion', toolCallId: 'q-1' });
    expect(session.pendingPermission).toMatchObject({
      toolName: 'AskUserQuestion',
      input: {
        questions: [
          { id: 'db', question: 'Which database?', header: 'Database', options: [{ label: 'Postgres (Recommended)', description: 'SQL' }, { label: 'SQLite', description: 'File' }] },
          { id: 'auth', question: 'Who signs in?', header: 'Auth', options: [{ label: 'Members' }, { label: 'Anyone' }] },
        ],
      },
    });
    const text = chatReply([
      ['Which database?', 'Postgres'],
      ['Who signs in?', 'Only the owner'],
    ]);
    await session.answerQuestion({ answer: text, toolCallId: 'q-1' });
    await until(() => ended(events).length === 2, 'answered');
    expect(answers).toEqual({ answers: { db: { answers: ['Postgres'] }, auth: { answers: ['Only the owner'] } } });
    expect(transcript).toContainEqual({ kind: 'question_answer', toolCallId: 'q-1', answer: text });
    expect(ended(events).at(-1)).toEqual({ type: 'agent_end', reason: 'complete' });
  });

  it('cancels a question card the session no longer waits on when the person writes instead', async () => {
    let answers: unknown;
    const spawn = scripted([
      async (server, { threadId, turnId }) => {
        answers = (await server.request('item/tool/requestUserInput', { threadId, turnId, itemId: 'q-1', questions: [{ id: 'a', header: 'A', question: 'Which?' }] })).result;
      },
      reply('Fine.'),
    ]);
    const { session, events } = await harnessWith(spawn);
    await session.sendMessage({ content: 'go' });
    await session.sendMessage({ content: 'forget it, do something else' });
    expect(events).toContainEqual({ type: 'tool_suspension_cancelled', toolCallId: 'q-1' });
    expect(answers).toEqual({ answers: {} });
    expect(session.pendingPermission).toBeUndefined();
  });

  it("asks an MCP server's form as a question card and answers it with typed content", async () => {
    let response: unknown;
    const spawn = scripted([
      async (server, { threadId, turnId }) => {
        response = (
          await server.request('mcpServer/elicitation/request', {
            threadId,
            turnId,
            serverName: 'deploy',
            mode: 'form',
            message: 'Deploy where?',
            requestedSchema: {
              type: 'object',
              properties: {
                env: { type: 'string', title: 'Environment', enum: ['staging', 'prod'], enumNames: ['Staging', 'Production'] },
                replicas: { type: 'number', title: 'Replicas' },
              },
              required: ['env'],
            },
            _meta: null,
          })
        ).result;
        reply('Deployed.')(server, { threadId, turnId, params: {} });
      },
    ]);
    const { session, events } = await harnessWith(spawn);
    expect(await session.sendMessage({ content: 'deploy' })).toEqual({ reason: 'suspended' });
    const pending = session.pendingPermission!;
    expect(pending.toolName).toBe('AskUserQuestion');
    expect(pending.input).toEqual({
      questions: [
        { id: 'env', header: 'Environment', question: 'Deploy where?\n\nEnvironment', options: [{ label: 'Staging' }, { label: 'Production' }] },
        { id: 'replicas', header: 'Replicas', question: 'Replicas' },
      ],
    });
    await session.answerQuestion({
      answer: chatReply([
        ['Deploy where?\n\nEnvironment', 'Production'],
        ['Replicas', '2'],
      ]),
      toolCallId: pending.toolCallId,
    });
    await until(() => ended(events).length === 2, 'answered');
    expect(response).toEqual({ action: 'accept', content: { env: 'prod', replicas: 2 } });
  });

  it('declines a form the person turns down', async () => {
    let response: unknown;
    const spawn = scripted([
      async (server, { threadId, turnId }) => {
        response = (await server.request('mcpServer/elicitation/request', { threadId, turnId, serverName: 'x', mode: 'form', message: 'Name?', requestedSchema: { type: 'object', properties: { name: { type: 'string' } } } })).result;
        reply('ok')(server, { threadId, turnId, params: {} });
      },
    ]);
    const { session, events } = await harnessWith(spawn);
    await session.sendMessage({ content: 'go' });
    await session.respondToToolApproval({ approved: false });
    await until(() => ended(events).length === 2, 'declined');
    expect(response).toEqual({ action: 'decline' });
  });

  it("names the tool of an MCP approval from the CLI's message", () => {
    expect(
      codexMcpToolApproval({ serverName: 'factory', message: 'Allow factory to run tool "factory_signal_session"?', _meta: { codex_approval_kind: 'mcp_tool_call', tool_title: 'Signal session' } }),
    ).toEqual({ server: 'factory', tool: 'factory_signal_session', message: 'Allow factory to run tool "factory_signal_session"?' });
    expect(codexMcpToolApproval({ serverName: 'x', message: 'Name?', _meta: null })).toBeUndefined();
  });

  it("records a subagent's work under its Agent call and parks its approval in the same turn", async () => {
    let approval: unknown;
    const spawn = scripted([
      async (server, { threadId, turnId }) => {
        const child = { threadId: 'child-1', turnId: 'child-turn' };
        server.notify('item/completed', { threadId, turnId, item: { type: 'subAgentActivity', id: 'call_A', kind: 'started', agentThreadId: 'child-1', agentPath: '/root/writer' } });
        server.notify('turn/started', { threadId: 'child-1', turn: { id: 'child-turn', status: 'inProgress' } });
        server.notify('item/started', { ...child, item: { type: 'commandExecution', id: 'exec-1', command: 'touch f.txt', cwd: '/w', status: 'inProgress' } });
        approval = (await server.request('item/commandExecution/requestApproval', { ...child, itemId: 'exec-1', command: 'touch f.txt', cwd: '/w' })).result;
        server.notify('item/completed', { ...child, item: { type: 'commandExecution', id: 'exec-1', command: 'touch f.txt', cwd: '/w', status: 'completed', aggregatedOutput: '', exitCode: 0 } });
        server.notify('item/completed', { ...child, item: { type: 'agentMessage', id: 'm-child', text: 'Written.' } });
        server.notify('turn/completed', { threadId: 'child-1', turn: { id: 'child-turn', status: 'completed' } });
        server.notify('item/completed', { threadId, turnId, item: { type: 'subAgentActivity', id: 'done-A', kind: 'completed', agentThreadId: 'child-1', agentPath: '/root/writer' } });
        reply('The writer wrote it.')(server, { threadId, turnId, params: {} });
      },
    ]);
    const { session, events, transcript } = await harnessWith(spawn);
    expect(await session.sendMessage({ content: 'have a subagent write f.txt' })).toEqual({ reason: 'suspended' });
    expect(session.pendingPermission).toEqual({ toolCallId: 'child-1:exec-1', toolName: 'execute_command', input: { command: 'touch f.txt', cwd: '/w' }, parentToolCallId: 'call_A' });
    await session.respondToToolApproval({ approved: true });
    await until(() => ended(events).length === 2, 'resumed');
    expect(approval).toEqual({ decision: 'acceptForSession' });
    expect(ended(events).at(-1)).toEqual({ type: 'agent_end', reason: 'complete' });
    const work = transcript.filter(entry => entry.kind === 'tool_call' || entry.kind === 'tool_result' || entry.kind === 'text');
    expect(work).toEqual([
      { kind: 'tool_call', toolCallId: 'call_A', toolName: 'Agent', input: { description: 'writer', prompt: '', subagent_type: 'writer' } },
      { kind: 'tool_call', toolCallId: 'child-1:exec-1', toolName: 'execute_command', input: { command: 'touch f.txt', cwd: '/w' }, parentToolCallId: 'call_A' },
      { kind: 'tool_call', toolCallId: 'child-1:exec-1:0:run', toolName: 'execute_command', input: { command: 'touch f.txt', cwd: '/w' }, parentToolCallId: 'call_A' },
      { kind: 'tool_result', toolCallId: 'child-1:exec-1:0:run', content: 'Exit code 0', isError: false, parentToolCallId: 'call_A' },
      { kind: 'text', text: 'Written.', messageId: 'm-child', parentToolCallId: 'call_A' },
      { kind: 'tool_result', toolCallId: 'call_A', content: 'Written.', isError: false },
      { kind: 'text', text: 'The writer wrote it.', messageId: 'msg-turn-1' },
    ]);
  });

  it('steers the turn in flight with a message instead of stopping it', async () => {
    let release!: () => void;
    const spawn = scripted([
      async (server, turn) => {
        await new Promise<void>(resolve => (release = resolve));
        reply('Done, with the steer.')(server, turn);
      },
    ]);
    const { session, events, transcript } = await harnessWith(spawn);
    const run = session.sendMessage({ content: 'refactor it' });
    await until(() => typeof release === 'function', 'turn');
    const server = spawn.servers[0]!;
    server.handle('turn/steer', params => ({ turnId: params.expectedTurnId }));
    expect(await session.sendChatMessage({ content: 'keep the old API', delivery: 'steer' })).toEqual({ action: 'deliver' });
    expect(server.requests('turn/steer')[0]!.params).toEqual({ threadId: 'thread-1', expectedTurnId: 'turn-1', input: [{ type: 'text', text: 'keep the old API' }] });
    expect(server.requests('turn/interrupt')).toEqual([]);
    release();
    expect(await run).toEqual({ reason: 'complete' });
    expect(server.requests('turn/start')).toHaveLength(1);
    expect(transcript).toContainEqual({ kind: 'input', source: 'signal', text: 'keep the old API', delivery: 'while-active' });
    expect(ended(events)).toEqual([{ type: 'agent_end', reason: 'complete' }]);
  });

  it('stops and starts over with a steer the turn can no longer take', async () => {
    const spawn = scripted([async () => {}, reply('Started over.')]);
    const { session, events } = await harnessWith(spawn);
    void session.sendMessage({ content: 'one' });
    await until(() => (spawn.servers[0]?.requests('turn/start').length ?? 0) === 1, 'turn');
    await until(() => session.run.isRunning() && session.stream.isActive(), 'active');
    // The fake does not know `turn/steer`: the run is stopped and the message starts a new one.
    expect(await session.sendChatMessage({ content: 'two', delivery: 'steer' })).toEqual({ action: 'wake' });
    await until(() => ended(events).length === 2, 'restarted');
    expect(ended(events).map(event => event.reason)).toEqual(['aborted', 'complete']);
  });

  it('keeps a generated image with the session', async () => {
    const kept: unknown[] = [];
    const spawn = scripted([
      (server, { threadId, turnId }) => {
        server.notify('item/completed', { threadId, turnId, item: { type: 'imageGeneration', id: 'ig1', status: 'completed', revisedPrompt: 'A fox', savedPath: '/homes/s1/images/fox.png' } });
        reply('Here it is.')(server, { threadId, turnId, params: {} });
      },
    ]);
    const { session, transcript } = await harnessWith(spawn, { onImageGenerated: async (_session, image) => void kept.push(image) });
    await session.sendMessage({ content: 'draw a fox' });
    await until(() => kept.length === 1, 'image kept');
    expect(kept).toEqual([{ path: '/homes/s1/images/fox.png', itemId: 'ig1', prompt: 'A fox' }]);
    expect(transcript).toContainEqual({ kind: 'tool_call', toolCallId: 'ig1', toolName: 'generate_image', input: { prompt: 'A fox' } });
  });

  it('moves a parked turn to another account when it runs out of usage after the answer', async () => {
    const tokens = (id: string) => ({ accessToken: `at-${id}`, chatgptAccountId: `ws-${id}` });
    let answered: unknown;
    const spawn = scripted([
      async (server, { threadId, turnId }) => {
        answered = (await server.request('item/commandExecution/requestApproval', { threadId, turnId, itemId: 'cmd-1', command: 'make' })).result;
        server.notify('error', { threadId, turnId, willRetry: false, error: { message: 'You hit your usage limit.', codexErrorInfo: 'usageLimitExceeded' } });
        server.notify('turn/completed', { threadId, turn: { id: turnId, status: 'failed', error: { message: 'usage limit' } } });
      },
      reply('Built.'),
    ]);
    const failures: string[] = [];
    const { session, events } = await harnessWith(spawn, {
      credentials: async (_session, request) => (request.exclude.includes('acc-a') ? { tokens: tokens('b'), accountId: 'acc-b' } : { tokens: tokens('a'), accountId: 'acc-a' }),
      onCredentialFailure: async (_session, failure) => void failures.push(failure.accountId),
    });
    expect(await session.sendMessage({ content: 'build it' })).toEqual({ reason: 'suspended' });
    await session.respondToToolApproval({ approved: true });
    await until(() => ended(events).length === 2, 'resumed');
    expect(answered).toEqual({ decision: 'acceptForSession' });
    expect(failures).toEqual(['acc-a']);
    expect(ended(events).at(-1)).toEqual({ type: 'agent_end', reason: 'complete' });
    const server = spawn.servers[0]!;
    expect(spawn.servers).toHaveLength(1);
    expect(server.requests('account/login/start').map(message => (message.params as { accessToken: string }).accessToken)).toEqual(['at-a', 'at-b']);
    const turns = server.requests('turn/start').map(message => (message.params as { input: Array<{ text: string }> }).input[0]!.text);
    expect(turns).toHaveLength(2);
    expect(turns[1]).toBe(CODEX_ACCOUNT_SWITCH_PROMPT);
    expect(events.find(event => event.type === 'error')).toBeUndefined();
  });
});

describe('Codex session usage-limit park', () => {
  const tokens = (id: string) => ({ accessToken: `at-${id}`, chatgptAccountId: `ws-${id}` });
  const resetsAt = new Date(Date.now() + 90 * 60_000);
  const pool = (limited: { at: Date | undefined }) => async () => {
    if (limited.at) throw new CodexError('rate_limit', 'Every ChatGPT account this run may use is out of usage.', { resetsAt: limited.at });
    return { tokens: tokens('a'), accountId: 'acc-a' };
  };
  const turnTexts = (spawn: ReturnType<typeof scripted>) =>
    spawn.servers.flatMap(server => server.requests('turn/start').map(message => (message.params as { input: Array<{ text: string }> }).input[0]!.text));

  it('parks until the reset with the request pending, and the resume sends it', async () => {
    const limited = { at: resetsAt as Date | undefined };
    const spawn = scripted([reply('Done.')]);
    const { session, events, store } = await harnessWith(spawn, { credentials: pool(limited), parkOnUsageLimit: () => true });
    await session.sendChatMessage({ content: 'build it' });
    await until(() => ended(events).at(-1)?.reason === 'error', 'limited run');
    expect(events.some(event => event.type === 'error')).toBe(false);
    expect(session.usageLimitPark).toMatchObject({ until: resetsAt.toISOString(), attempts: 1, resetKnown: true });
    expect(events).toContainEqual({ type: 'usage_limit_parked', park: session.usageLimitPark });
    expect((await store.get('s1'))!.threads.s1!.pendingInputs.map(input => input.text)).toEqual(['build it']);

    // Still limited: parks anew, until the new reset.
    const later = new Date(resetsAt.getTime() + 30 * 60_000);
    limited.at = later;
    expect(await session.resumeFromUsageLimit()).toMatchObject({ action: 'parked', park: { until: later.toISOString(), attempts: 2 } });

    limited.at = undefined;
    expect(await session.resumeFromUsageLimit()).toMatchObject({ action: 'resumed' });
    await until(() => ended(events).at(-1)?.reason === 'complete', 'resumed run');
    expect(turnTexts(spawn)).toEqual([expect.stringContaining('build it')]);
    expect(session.usageLimitPark).toBeUndefined();
  });

  it('goes on with the turn the limit cut off once Codex had it', async () => {
    const limited = { at: undefined as Date | undefined };
    const spawn = scripted([
      (server, { threadId, turnId }) => {
        // The only account runs out mid-turn; the pool has no other.
        limited.at = resetsAt;
        server.notify('error', { threadId, turnId, willRetry: false, error: { message: 'You hit your usage limit.', codexErrorInfo: 'usageLimitExceeded' } });
        server.notify('turn/completed', { threadId, turn: { id: turnId, status: 'failed', error: { message: 'usage limit' } } });
      },
      reply('Built.'),
    ]);
    const { session, events } = await harnessWith(spawn, { credentials: pool(limited), parkOnUsageLimit: () => true });
    await session.sendChatMessage({ content: 'build it' });
    await until(() => ended(events).at(-1)?.reason === 'error', 'limited run');
    expect(session.usageLimitPark?.continueTurn).toBe(true);

    limited.at = undefined;
    await session.resumeFromUsageLimit();
    await until(() => ended(events).at(-1)?.reason === 'complete', 'resumed run');
    const texts = turnTexts(spawn);
    expect(texts).toHaveLength(2);
    expect(texts[1]).toContain('Continue where you stopped');
    expect(texts[1]).not.toContain('build it');
  });

  it('fails as before when the host does not park the session', async () => {
    const spawn = scripted([reply('Done.')]);
    const { session, events } = await harnessWith(spawn, { credentials: pool({ at: resetsAt }), parkOnUsageLimit: () => false });
    await session.sendChatMessage({ content: 'build it' });
    await until(() => ended(events).at(-1)?.reason === 'error', 'limited run');
    expect(events.some(event => event.type === 'error')).toBe(true);
    expect(session.usageLimitPark).toBeUndefined();
  });
});
