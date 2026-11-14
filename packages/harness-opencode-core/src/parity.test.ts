// Scenarios of t3code's OpenCode provider tests, written against this harness. Each `it` names the
// t3 case it covers in docs/features/harnesses/opencode-test-parity.md.
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentEvent, AgentRunContext } from '@factory/harness';
import type { TranscriptEntry } from '@factory/harness/transcript';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { OpenCodeClient, OpenCodeHttpError, parseServerSentEvents, type OpenCodeEvent, type OpenCodeProviderList } from './client.ts';
import { openCodeConfigContent, openCodePermissionRules } from './config.ts';
import { buildOpenCodeEnv, openCodeStateDirs } from './env.ts';
import { isTerminalRetry, openCodeErrorFrom } from './errors.ts';
import { openCodeToolCall, OpenCodeTurnTranslator } from './events.ts';
import { createOpenCodeHarness } from './harness.ts';
import { createOpenCodeCatalogSource } from './models.ts';
import { compareVersions, parseOpenCodeVersion } from './server.ts';
import { openCodeQuestionAnswers, type OpenCodeSession, type OpenCodeSessionConfig } from './session.ts';
import { createInMemoryOpenCodeSessionStore, emptyOpenCodeThreadState, type OpenCodeSessionStore } from './store.ts';
import { startFakeOpenCode, type FakeOpenCode } from './testkit.ts';
import { openCodeGoUsageToLimits, readOpenCodeAccountLimits } from './usage.ts';

const sid = 'ses_root';
const busy: OpenCodeEvent = { type: 'session.status', properties: { sessionID: sid, status: { type: 'busy' } } };
const idle: OpenCodeEvent = { type: 'session.status', properties: { sessionID: sid, status: { type: 'idle' } } };
const toolPart = (callID: string, tool: string, state: Record<string, unknown>, sessionID = sid): OpenCodeEvent => ({
  type: 'message.part.updated',
  properties: { sessionID, part: { id: `prt_${callID}`, messageID: 'msg_a', sessionID, type: 'tool', tool, callID, state } },
});
const step = (id: string, tokens = { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 4 } }): OpenCodeEvent => ({
  type: 'message.part.updated',
  properties: { sessionID: sid, part: { id, messageID: 'msg_a', sessionID: sid, type: 'step-finish', reason: 'stop', cost: 0.01, tokens } },
});
const translator = (options: { planning?: boolean; mcpServers?: string[] } = {}) => {
  const t = new OpenCodeTurnTranslator({ sessionId: sid, ...options });
  t.handle(busy);
  return t;
};

describe('errors (t3 adapter.test: provider failures, usage limits; status.test: ports)', () => {
  it.each([
    { message: '<none>', statusCode: 503, responseBody: '<title> Service\n unavailable </title>', expected: 'Service unavailable (HTTP 503).' },
    { message: ' <NoNe> ', statusCode: 502, responseBody: 'bad gateway', expected: 'The model provider failed the request (HTTP 502).' },
    { message: '<none>', expected: 'The model provider failed the request and did not include an error message.' },
    { message: 'provider says no', statusCode: 503, responseBody: '<title>Unavailable</title>', expected: 'provider says no' },
    { message: '<none>', statusCode: 503, responseBody: '<title>https://user:secret@example.com/error?token=secret</title>', expected: 'https://example.com/error (HTTP 503).' },
  ])('reads a provider failure as a person can, without its secrets: $expected', ({ expected, ...data }) => {
    expect(openCodeErrorFrom({ name: 'APIError', data }).message).toBe(expected);
  });

  it('tells limits apart: a 429 and an exhausted budget are limits, missing funds are not', () => {
    expect(openCodeErrorFrom({ name: 'APIError', data: { message: 'Provider rejected request', statusCode: 429, isRetryable: true } }).kind).toBe('rate_limit');
    expect(openCodeErrorFrom({ name: 'APIError', data: { message: 'Account budget exceeded', statusCode: 429 } }).kind).toBe('rate_limit');
    expect(openCodeErrorFrom({ name: 'APIError', data: { statusCode: 429, responseBody: '{"error":{"type":"GoUsageLimitError","message":"Go usage limit reached"}}' } }).kind).toBe('rate_limit');
    expect(openCodeErrorFrom({ name: 'APIError', data: { message: 'Insufficient account funds', statusCode: 402 } }).kind).not.toBe('rate_limit');
  });

  it('does not read a port or a count of 401/403 as a refused key', () => {
    for (const port of [401, 403, 4010, 4030]) {
      expect(openCodeErrorFrom({ data: { message: `connect ECONNREFUSED 127.0.0.1:${port}` } }).kind).not.toBe('auth');
      expect(isTerminalRetry(`connect ECONNREFUSED 127.0.0.1:${port}`)).toBe(false);
    }
    expect(openCodeErrorFrom({ data: { message: 'Request failed with status code 401' } }).kind).toBe('auth');
  });

  it('keeps retrying a rate limit per minute, stops at an exhausted allowance', () => {
    expect(isTerminalRetry('Rate limit exceeded: free-models-per-min')).toBe(false);
    expect(isTerminalRetry('Too Many Requests')).toBe(false);
    expect(isTerminalRetry('Free usage limit reached. Subscribe to OpenCode Go')).toBe(true);
    const t = translator();
    expect(t.handle({ type: 'session.status', properties: { sessionID: sid, status: { type: 'retry', attempt: 1, message: 'Rate Limited' } } }).terminal).toBeUndefined();
    t.handle({ type: 'session.error', properties: { sessionID: sid, error: { name: 'APIError', data: { message: 'Rate limit exceeded', statusCode: 429 } } } });
    t.handle(idle);
    expect(t.outcome()).toMatchObject({ kind: 'error', error: { kind: 'rate_limit' } });
  });
});

describe('the turn translator (t3 adapter.test)', () => {
  it('counts each step once, cache inside the prompt and reasoning inside the completion', () => {
    const t = translator();
    const usage = [step('one'), step('one'), step('two')].map(event => t.handle(event).usage).filter(Boolean);
    expect(usage).toHaveLength(2);
    expect(t.usage).toEqual({ promptTokens: 34, completionTokens: 14, reasoningTokens: 4, cachedInputTokens: 6, cacheCreationInputTokens: 8, totalTokens: 48 });
    // A failed turn still reports what it used.
    t.handle({ type: 'session.error', properties: { sessionID: sid, error: { name: 'UnknownError', data: { message: 'failed' } } } });
    t.handle(idle);
    expect(t.outcome()).toMatchObject({ kind: 'error' });
    expect(t.usage.promptTokens).toBe(34);
    // A turn with no step reports none.
    expect(translator().usage).toEqual({});
  });

  it('holds an idle that comes before OpenCode took the prompt (an earlier turn’s)', () => {
    const t = new OpenCodeTurnTranslator({ sessionId: sid, promptedAt: Date.now() });
    expect(t.handle(idle).idle).toBeUndefined();
    expect(t.handle({ type: 'session.idle', properties: { sessionID: sid } }).idle).toBeUndefined();
    // An earlier turn's message, created long before this prompt, is no proof either.
    t.handle({ type: 'message.updated', properties: { sessionID: sid, info: { id: 'msg_old', role: 'user', time: { created: Date.now() - 60_000 } } } });
    expect(t.handle(idle).idle).toBeUndefined();
    t.handle({ type: 'message.updated', properties: { sessionID: sid, info: { id: 'msg_new', role: 'user', time: { created: Date.now() } } } });
    expect(t.handle(idle).idle).toBe(true);
  });

  it('ends a turn OpenCode refused before running it (an error and no busy)', () => {
    const t = new OpenCodeTurnTranslator({ sessionId: sid });
    const update = t.handle({ type: 'session.error', properties: { sessionID: sid, error: { name: 'ProviderModelNotFoundError', data: { message: 'Model not found: opencode/nope' } } } });
    expect(update.terminal).toMatchObject({ kind: 'model_unavailable' });
  });

  it('follows a command through its states: output, failure, interruption, a non-zero exit', () => {
    const t = translator();
    const entries = [
      toolPart('call_w', 'bash', { status: 'pending', input: { command: 'pwd' }, raw: '' }),
      toolPart('call_w', 'bash', { status: 'running', input: { command: 'pwd' }, title: 'Working directory', time: { start: 1 } }),
      toolPart('call_w', 'bash', { status: 'completed', input: { command: 'pwd' }, output: '/repo\n', metadata: {}, time: { start: 1, end: 2 } }),
      toolPart('call_e', 'bash', { status: 'error', input: { command: 'pwd' }, error: 'Command failed', time: { start: 3, end: 4 } }),
      toolPart('call_i', 'bash', { status: 'error', input: { command: 'sleep 90' }, error: 'Tool execution aborted', time: { start: 6, end: 7 } }),
      toolPart('call_x', 'bash', { status: 'completed', input: { command: 'vp test' }, output: '1 failed\n', metadata: { output: '1 failed\n', exit: 1 }, time: { start: 4, end: 5 } }),
      toolPart('call_t', 'task', { status: 'error', input: { description: 'Sleep task', prompt: 'sleep 120', subagent_type: 'general' }, error: 'Task failed', time: { start: 7, end: 8 } }),
    ].flatMap(event => t.handle(event).entries);
    expect(entries).toEqual([
      { kind: 'tool_call', toolCallId: 'call_w', toolName: 'execute_command', input: { command: 'pwd' } },
      { kind: 'tool_result', toolCallId: 'call_w', content: '/repo\n', isError: false },
      { kind: 'tool_call', toolCallId: 'call_e', toolName: 'execute_command', input: { command: 'pwd' } },
      { kind: 'tool_result', toolCallId: 'call_e', content: 'Command failed', isError: true },
      { kind: 'tool_call', toolCallId: 'call_i', toolName: 'execute_command', input: { command: 'sleep 90' } },
      { kind: 'tool_result', toolCallId: 'call_i', content: 'Tool execution aborted', isError: true },
      { kind: 'tool_call', toolCallId: 'call_x', toolName: 'execute_command', input: { command: 'vp test' } },
      { kind: 'tool_result', toolCallId: 'call_x', content: '1 failed\n\nExit code 1', isError: true },
      { kind: 'tool_call', toolCallId: 'call_t', toolName: 'Agent', input: { description: 'Sleep task', prompt: 'sleep 120', subagent_type: 'general' } },
      { kind: 'tool_result', toolCallId: 'call_t', content: 'Task failed', isError: true },
    ]);
  });

  it('asks about reading outside the checkout on the read call, as an ask a person’s Allow never covers', () => {
    const t = translator();
    t.handle(toolPart('call_r', 'read', { status: 'pending', input: { filePath: '/outside/file' }, raw: '' }));
    const update = t.handle({
      type: 'permission.asked',
      properties: { id: 'per_r', sessionID: sid, permission: 'external_directory', patterns: ['/outside/*'], always: [], metadata: {}, tool: { messageID: 'msg_a', callID: 'call_r' } },
    });
    expect(update.permission).toEqual({ requestId: 'per_r', request: { toolCallId: 'call_r', toolName: 'view', input: { path: '/outside/file' } }, alwaysAsks: true });
  });

  it('drops cancelled todos, so a finished list reads finished', () => {
    expect(
      openCodeToolCall('todowrite', {
        todos: [
          { content: 'Write the fix', status: 'completed' },
          { content: 'Try another approach', status: 'cancelled' },
          { content: 'Add a test', status: 'completed' },
        ],
      }).input,
    ).toEqual({ todos: [{ content: 'Write the fix', status: 'completed', activeForm: 'Write the fix' }, { content: 'Add a test', status: 'completed', activeForm: 'Add a test' }] });
  });

  it('names MCP calls by their server, whatever characters its name has', () => {
    expect(openCodeToolCall('my_server_with_underscores_edit_document', { document: 'remote-doc' }, ['my.server_with_underscores'])).toEqual({
      toolName: 'mcp__my.server_with_underscores__edit_document',
      input: { document: 'remote-doc' },
    });
    // Two servers whose names prefix each other: the longer one is the tool's (t3 leaves it unnamed).
    expect(openCodeToolCall('ambiguous_server_edit_document', {}, ['ambiguous', 'ambiguous_server']).toolName).toBe('mcp__ambiguous_server__edit_document');
    const t = translator({ mcpServers: ['factory'] });
    const entries = ['running', 'completed'].flatMap(status => t.handle(toolPart('mcp', 'factory_bound_work_item', { status, input: { id: 1 }, output: 'ok', metadata: {} })).entries);
    expect(entries).toEqual([
      { kind: 'tool_call', toolCallId: 'mcp', toolName: 'mcp__factory__bound_work_item', input: { id: 1 } },
      { kind: 'tool_result', toolCallId: 'mcp', content: 'ok', isError: false },
    ]);
    expect(t.handle(toolPart('mcp_e', 'factory_bound_work_item', { status: 'error', input: { id: 2 }, error: 'failed' })).entries.at(-1)).toEqual({ kind: 'tool_result', toolCallId: 'mcp_e', content: 'failed', isError: true });
  });

  it('keeps file content exactly: an emptied line, whitespace, an empty file', () => {
    expect(openCodeToolCall('edit', { filePath: '/a', oldString: 'old\n', newString: '' }).input).toEqual({ path: '/a', old_string: 'old\n', new_string: '' });
    expect(openCodeToolCall('edit', { filePath: '/a', oldString: 'x', newString: '  \n\t' }).input).toEqual({ path: '/a', old_string: 'x', new_string: '  \n\t' });
    expect(openCodeToolCall('write', { filePath: '/a', content: '' }).input).toEqual({ path: '/a', content: '' });
  });

  it('keeps a multi-select question multi-select, and answers it with every choice', () => {
    const t = translator();
    const update = t.handle({
      type: 'question.asked',
      properties: { id: 'question', sessionID: sid, questions: [{ header: 'Drinks', question: 'Which drinks?', multiple: true, custom: false, options: [{ label: 'Tea', description: 'Hot' }, { label: 'Water', description: 'Cold' }] }] },
    });
    expect(update.question?.request.input).toEqual({ questions: [{ question: 'Which drinks?', header: 'Drinks', options: [{ label: 'Tea', description: 'Hot' }, { label: 'Water', description: 'Cold' }], multiSelect: true }] });
    expect(openCodeQuestionAnswers(update.question!.questions, ['Tea', 'Water'])).toEqual([['Tea', 'Water']]);
  });

  it('skips events it cannot read, and goes on with the turn', async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of ['data: not json\n\n', 'data: {"no":"type"}\n\n', 'data: {"type":"session.status","properties":{"sessionID":"ses_root","status":{"type":"busy"}}}\n\n']) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    const events: OpenCodeEvent[] = [];
    for await (const event of parseServerSentEvents(body)) events.push(event);
    expect(events.map(event => event.type)).toEqual(['session.status']);
    const t = translator();
    expect(t.handle({ type: 'session.next.durable', properties: { sessionID: sid, durable: 'not-an-envelope' } })).toEqual({ entries: [] });
    expect(t.handle(idle).idle).toBe(true);
  });
});

describe('permission rules (t3 adapter.test: runtime modes, sandbox policy)', () => {
  it('asks about a tool no rule names, first, so the named rules win', () => {
    const rules = openCodePermissionRules({}, ['factory']);
    expect(Object.keys(rules)[0]).toBe('*');
    expect(rules).toMatchObject({ '*': 'ask', read: 'allow', todoread: 'allow', question: 'allow', edit: 'ask', bash: 'ask', doom_loop: 'ask', external_directory: 'ask', 'factory_*': 'allow', codesearch: 'allow' });
    expect(openCodePermissionRules({ edit: 'allow', bash: 'allow' })).toMatchObject({ '*': 'ask', external_directory: 'ask', doom_loop: 'ask' });
    // A Factory tool asked about each time is asked about, after its server's allow.
    const each = openCodePermissionRules({ askEachTime: ['mcp__factory__factory_retry_decision'] }, ['factory']);
    expect(Object.keys(each).indexOf('factory_factory_retry_decision')).toBeGreaterThan(Object.keys(each).indexOf('factory_*'));
    expect(each.factory_factory_retry_decision).toBe('ask');
  });

  it('refuses everything that would ask when nobody can answer, and never allows everything', () => {
    const rules = openCodePermissionRules({ unattended: true, web: 'deny' });
    expect(rules).toMatchObject({ '*': 'deny', read: 'allow', edit: 'deny', bash: 'deny', webfetch: 'deny', codesearch: 'deny', doom_loop: 'deny', external_directory: 'deny' });
    expect(Object.values(openCodePermissionRules({ edit: 'allow', bash: 'allow', web: 'allow' }))).toContain('ask');
    expect(JSON.parse(openCodeConfigContent({ policy: {}, mcpServers: { factory: { url: 'https://f/mcp' } } })).permission['factory_*']).toBe('allow');
  });
});

describe('server, client and environment helpers (t3 versionProbe, OpenCode2Client, environment tests)', () => {
  it('reads versions as OpenCode prints them, and refuses what is not one', () => {
    expect(compareVersions('v1.20.0', '1.14.19')).toBeGreaterThan(0);
    expect(compareVersions('1.14.19-beta.1', '1.14.19')).toBeLessThan(0);
    expect(compareVersions('1.14.19', '1.14.19')).toBe(0);
    expect(parseOpenCodeVersion('1.14')).toEqual({ core: [1, 14, 0] });
    expect(parseOpenCodeVersion('local')).toBeUndefined();
    expect(() => compareVersions('local', '1.14.19')).toThrow(/Not a version/);
  });

  it('sends a non-ASCII password as UTF-8 Basic auth', async () => {
    const seen: Array<string | null> = [];
    const client = new OpenCodeClient({
      baseUrl: 'http://127.0.0.1:1',
      password: 'pässwörd',
      directory: '/w',
      fetch: async (_url, init) => {
        seen.push(new Headers(init?.headers).get('authorization'));
        return new Response(JSON.stringify({ healthy: true, version: '1.19.5' }), { status: 200 });
      },
    });
    await client.health();
    expect(seen).toEqual([`Basic ${Buffer.from('opencode:pässwörd', 'utf8').toString('base64')}`]);
  });

  it('gives the server only its own password: the host’s never passes', () => {
    const env = buildOpenCodeEnv(
      { PATH: '/bin', OPENCODE_SERVER_PASSWORD: 'host-password', OPENCODE_SERVER_USERNAME: 'host-user', OPENCODE_AUTH_CONTENT: '{"x":1}' },
      { dirs: openCodeStateDirs('/s'), configContent: '{}', password: 'own' },
    );
    expect(env.OPENCODE_SERVER_PASSWORD).toBe('own');
    expect(env.OPENCODE_SERVER_USERNAME).toBeUndefined();
    expect(env.OPENCODE_AUTH_CONTENT).toBeUndefined();
  });
});

describe('usage windows and the catalog (t3 status.test, driver.test)', () => {
  it('clamps Go windows and keeps their reset times; leaves out what it cannot read', () => {
    const limits = openCodeGoUsageToLimits(
      { usage: { rolling: { percent: 125, resetsAt: '2026-11-15T00:00:00Z' }, weekly: { percent: -5 }, monthly: { percent: '50', resetsAt: 'soon' } } },
      '2026-11-14T00:00:00.000Z',
    );
    expect(limits.windows).toEqual([
      { id: 'go_rolling', kind: 'session', windowDurationMins: 300, usedPercent: 100, resetsAt: '2026-11-15T00:00:00.000Z' },
      { id: 'go_weekly', kind: 'weekly', windowDurationMins: 10080, usedPercent: 0 },
    ]);
  });

  it('tells a broken usage answer from a key without Go', async () => {
    const answer = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status });
    expect((await readOpenCodeAccountLimits('k', { fetch: answer(200, {}) })).unavailable?.reason).toBe('failed');
    expect((await readOpenCodeAccountLimits('k', { fetch: answer(200, { usage: { rolling: {} } }) })).unavailable?.reason).toBe('failed');
    expect((await readOpenCodeAccountLimits('k', { fetch: answer(403, {}) })).unavailable?.reason).toBe('unsupported');
  });

  it('retries a failed or empty catalog soon, keeps a good one, and shows no server answer to a person', async () => {
    let clock = 0;
    const listed: OpenCodeProviderList = { all: [{ id: 'opencode', models: { 'big-pickle': { id: 'big-pickle', cost: { input: 0, output: 0 } } } }] };
    const answers: Array<() => Promise<{ providers: OpenCodeProviderList }>> = [
      async () => {
        throw new OpenCodeHttpError('provider.list', 500, '{"token":"leak"}');
      },
      async () => ({ providers: { all: [{ id: 'opencode', models: {} }] } }),
      async () => ({ providers: listed }),
    ];
    let probes = 0;
    const catalog = createOpenCodeCatalogSource({ installed: () => true, probe: () => answers[Math.min(probes++, answers.length - 1)]!(), now: () => clock });
    const failed = await catalog();
    expect(failed).toMatchObject({ available: false, reason: 'OpenCode could not list its models: HTTP 500' });
    expect(failed.reason).not.toContain('leak');
    clock += 31_000;
    expect(await catalog()).toMatchObject({ available: false, reason: 'OpenCode lists no free models right now.' });
    clock += 31_000;
    expect(await catalog()).toMatchObject({ available: true });
    clock += 5 * 60_000;
    await catalog();
    expect(probes).toBe(3);
  });
});

// -- a session over the fake server -------------------------------------------------------------

const context: AgentRunContext = { get: () => undefined };
let fake: FakeOpenCode;
let root: string;

beforeEach(async () => {
  fake = await startFakeOpenCode();
  root = await mkdtemp(join(tmpdir(), 'opencode-parity-'));
});

afterEach(async () => {
  await fake.close();
});

async function session(config: Partial<OpenCodeSessionConfig> = {}, store: OpenCodeSessionStore = createInMemoryOpenCodeSessionStore()) {
  const work = await mkdtemp(join(root, 'work-'));
  const harness = createOpenCodeHarness({
    store,
    cwdFor: () => work,
    stateRootFor: s => join(root, 'state', s.id),
    spawn: fake.spawn,
    env: { PATH: '/usr/bin', HOME: '/home/agent' },
    turnSelectionFor: () => ({ model: 'opencode/big-pickle' }),
    ...config,
  });
  const created = await harness.createSession({ sessionId: 'session-1', threadId: 'thread-1' });
  const entries: TranscriptEntry[] = [];
  const events: AgentEvent[] = [];
  created.onTranscript(entry => entries.push(entry));
  created.subscribe(event => events.push(event));
  return { session: created as OpenCodeSession, entries, events };
}

const ended = (events: AgentEvent[]) => events.filter(event => event.type === 'agent_end').map(event => (event as { reason?: string }).reason);
const errors = (events: AgentEvent[]) => events.filter(event => event.type === 'error').map(event => (event as { error: unknown }).error);
const settle = (ms = 50) => new Promise(resolve => setTimeout(resolve, ms));
const askToWrite = (sessionId: string) => {
  fake.emit(toolPart('call_w', 'write', { status: 'running', input: { filePath: '/w/a.txt', content: 'a' } }, sessionId));
  fake.emit({ type: 'permission.asked', properties: { id: 'per_w', sessionID: sessionId, permission: 'edit', patterns: ['a.txt'], metadata: {}, always: [], tool: { messageID: 'msg_a', callID: 'call_w' } } });
};

describe('a session (t3 adapter.test, OpenCode2AdapterV2.test, orchestrator integration)', () => {
  it('starts the next turn of a run on a server with the new rules when the settings changed in between', async () => {
    let policy: { edit: 'ask' | 'allow' } = { edit: 'ask' };
    let s!: OpenCodeSession;
    fake.onPrompt = ({ sessionId }) => {
      if (fake.prompts.length === 1) {
        policy = { edit: 'allow' };
        void s.sendMessage({ content: 'and then', requestContext: context });
      }
      fake.say(sessionId, `turn ${fake.prompts.length}`);
      fake.idle(sessionId);
    };
    ({ session: s } = await session({ policyFor: () => policy }));
    expect(await s.sendMessage({ content: 'first', requestContext: context })).toEqual({ reason: 'complete' });
    expect(fake.spawns.map(spawn => JSON.parse(spawn.env.OPENCODE_CONFIG_CONTENT!).permission.edit)).toEqual(['ask', 'allow']);
    expect(fake.prompts.map(prompt => prompt.sessionId)).toEqual([fake.prompts[0]!.sessionId, fake.prompts[0]!.sessionId]);
    // A later run under the same rules starts one server.
    await s.sendMessage({ content: 'again', requestContext: context });
    expect(fake.spawns).toHaveLength(3);
  });

  it('sends each turn the model and variant picked for it', async () => {
    let selection: { model: string; variant?: string } = { model: 'opencode/big-pickle' };
    fake.onPrompt = ({ sessionId }) => fake.idle(sessionId);
    const { session: s } = await session({ turnSelectionFor: () => selection });
    await s.sendMessage({ content: 'one', requestContext: context });
    selection = { model: 'opencode/beam-free', variant: 'high' };
    await s.sendMessage({ content: 'two', requestContext: context });
    expect(fake.prompts.map(prompt => [prompt.input.model, prompt.input.variant])).toEqual([
      [{ providerID: 'opencode', modelID: 'big-pickle' }, undefined],
      [{ providerID: 'opencode', modelID: 'beam-free' }, 'high'],
    ]);
  });

  it('does not let the last turn’s idle end the next turn of the run', async () => {
    fake.admitPrompts = false;
    let s!: OpenCodeSession;
    fake.onPrompt = ({ sessionId }) => {
      if (fake.prompts.length === 1) {
        fake.emit({ ...busy, properties: { ...busy.properties, sessionID: sessionId } });
        void s.sendMessage({ content: 'second', requestContext: context });
        fake.say(sessionId, 'first answer');
        fake.idle(sessionId);
        return;
      }
      // What the first turn left on the stream arrives before OpenCode takes the second prompt.
      fake.idle(sessionId);
      fake.emit({ ...busy, properties: { ...busy.properties, sessionID: sessionId } });
      fake.say(sessionId, 'second answer');
      fake.idle(sessionId);
    };
    let entries: TranscriptEntry[];
    ({ session: s, entries } = await session());
    expect(await s.sendMessage({ content: 'first', requestContext: context })).toEqual({ reason: 'complete' });
    expect(entries.filter(entry => entry.kind === 'text').map(entry => (entry as { text: string }).text)).toEqual(['first answer', 'second answer']);
  });

  it('never lets an Allow of reading outside the checkout cover the next such read', async () => {
    fake.onPrompt = ({ sessionId }) => {
      fake.emit(toolPart(`call_${fake.prompts.length}`, 'read', { status: 'pending', input: { filePath: '/outside/file' }, raw: '' }, sessionId));
      fake.emit({ type: 'permission.asked', properties: { id: `per_${fake.prompts.length}`, sessionID: sessionId, permission: 'external_directory', patterns: ['/outside/*'], always: ['/outside/*'], metadata: {}, tool: { messageID: 'msg_a', callID: `call_${fake.prompts.length}` } } });
    };
    fake.onPermissionReply = () => fake.idle(fake.prompts.at(-1)!.sessionId);
    const { session: s } = await session();
    expect(await s.sendMessage({ content: 'read it', requestContext: context })).toEqual({ reason: 'suspended' });
    expect(s.pendingPermission).toMatchObject({ toolCallId: 'call_1', toolName: 'view', once: true });
    await s.respondToToolApproval({ approved: true, toolCallId: 'call_1' });
    await settle();
    expect(fake.permissionReplies).toEqual([{ requestId: 'per_1', reply: 'once' }]);
    expect(s.grantedTools).toEqual([]);
    expect(await s.sendMessage({ content: 'read it again', requestContext: context })).toEqual({ reason: 'suspended' });
    expect(s.pendingPermission).toMatchObject({ toolCallId: 'call_2' });
  });

  it('ends the turn when OpenCode does not take an answer', async () => {
    fake.onPrompt = ({ sessionId }) => askToWrite(sessionId);
    const { session: s, events } = await session();
    expect(await s.sendMessage({ content: 'write', requestContext: context })).toEqual({ reason: 'suspended' });
    fake.failing.set('permission.reply', 500);
    await s.respondToToolApproval({ approved: true, toolCallId: 'call_w' });
    await settle();
    expect(ended(events)).toEqual(['suspended', 'error']);
    expect(errors(events)[0]).toMatchObject({ kind: 'process', message: expect.stringContaining('did not take the answer to its permission') });
  });

  it('counts an answer to an ask OpenCode already dropped as delivered, and ends the turn it ended', async () => {
    fake.onPrompt = ({ sessionId }) => askToWrite(sessionId);
    const { session: s, events } = await session();
    expect(await s.sendMessage({ content: 'write', requestContext: context })).toEqual({ reason: 'suspended' });
    // OpenCode gave the ask up (its turn ended) while the person thought.
    fake.say(fake.prompts[0]!.sessionId, 'Gave up waiting.');
    fake.idle(fake.prompts[0]!.sessionId);
    await settle();
    fake.failing.set('permission.reply', 404);
    await s.respondToToolApproval({ approved: true, toolCallId: 'call_w' });
    await settle();
    expect(ended(events)).toEqual(['suspended', 'complete']);
    expect(errors(events)).toEqual([]);
  });

  it('fails the turn when the event stream ends cleanly mid-turn', async () => {
    fake.onPrompt = ({ sessionId }) => {
      fake.say(sessionId, 'half');
      fake.closeEvents();
    };
    const { session: s, events } = await session();
    expect(await s.sendMessage({ content: 'go', requestContext: context })).toEqual({ reason: 'error' });
    expect(errors(events)[0]).toMatchObject({ kind: 'process', message: 'The OpenCode server closed its event stream.' });
  });

  it('fails the run, instead of hanging, when the server never opens its event stream', async () => {
    fake.hangEvents = true;
    const { session: s, events } = await session({ startTimeoutMs: 200 });
    // A run that could not start rejects its send, as one whose server would not start does.
    await expect(s.sendMessage({ content: 'go', requestContext: context })).rejects.toMatchObject({ kind: 'timeout' });
    expect(ended(events)).toEqual(['error']);
    expect(fake.prompts).toEqual([]);
  });

  it('sends nothing for a turn stopped while its server starts', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const { session: s, events } = await session({ envFor: async () => (await gate, undefined) });
    const sent = s.sendMessage({ content: 'go', requestContext: context });
    await settle(20);
    s.abort();
    release();
    expect(await sent).toEqual({ reason: 'aborted' });
    await settle();
    expect(fake.prompts).toEqual([]);
    expect(fake.alive()).toBe(0);
    expect(ended(events)).toEqual(['aborted']);
  });

  it('stops a turn even when OpenCode’s abort fails', async () => {
    fake.onPrompt = () => {};
    fake.failing.set('abort', 500);
    const { session: s, events } = await session();
    const sent = s.sendMessage({ content: 'go', requestContext: context });
    while (fake.prompts.length === 0) await settle(5);
    s.abort();
    expect(await sent).toEqual({ reason: 'aborted' });
    await settle();
    expect(fake.aborts).toHaveLength(1);
    expect(errors(events)).toEqual([]);
  });

  it('gives up a turn that never ends, and tells OpenCode to stop it', async () => {
    fake.onPrompt = () => {};
    const { session: s, events } = await session({ turnTimeoutMs: 100 });
    expect(await s.sendMessage({ content: 'go', requestContext: context })).toEqual({ reason: 'error' });
    expect(errors(events)[0]).toMatchObject({ kind: 'timeout' });
    await settle();
    expect(fake.aborts).toEqual([fake.prompts[0]!.sessionId]);
  });

  it('keeps a refused prompt’s message for the next run, and reads a failing server as retryable', async () => {
    fake.failing.set('prompt_async', 502);
    fake.onPrompt = ({ sessionId }) => fake.idle(sessionId);
    const { session: s, events, entries } = await session();
    expect(await s.sendMessage({ content: 'first', requestContext: context })).toEqual({ reason: 'error' });
    expect(errors(events)[0]).toMatchObject({ kind: 'overloaded', status: 502 });
    fake.failing.delete('prompt_async');
    expect(await s.sendMessage({ content: 'next', requestContext: context })).toEqual({ reason: 'complete' });
    expect(fake.prompts[0]!.input.parts[0]!.text).toBe('first\n\nnext');
    expect(entries.filter(entry => entry.kind === 'input').map(entry => (entry as { text: string }).text)).toEqual(['first', 'next']);
  });

  it('answers an ask a restarted server lost as the next turn', async () => {
    const store = createInMemoryOpenCodeSessionStore();
    await store.put({
      sessionId: 'session-1',
      threadId: 'thread-1',
      threads: { 'thread-1': { ...emptyOpenCodeThreadState(), pendingPermission: { toolCallId: 'call_x', toolName: 'execute_command', input: { command: 'ls' } } } },
      updatedAt: new Date().toISOString(),
    });
    fake.onPrompt = ({ sessionId }) => fake.idle(sessionId);
    const { session: s } = await session({}, store);
    await s.respondToToolApproval({ approved: true, toolCallId: 'call_x' });
    await settle();
    expect(fake.permissionReplies).toEqual([]);
    expect(fake.prompts[0]!.input.parts[0]!.text).toContain('The person allowed `execute_command` for the rest of this session.');
    expect(s.grantedTools).toEqual(['execute_command']);
  });
});
