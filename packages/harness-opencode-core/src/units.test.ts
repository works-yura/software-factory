import { describe, expect, it } from 'vitest';

import { parseServerSentEvents, type OpenCodeProviderList } from './client.ts';
import { openCodeConfigContent, openCodePermissionRules, openCodeToolIdForTranscriptName } from './config.ts';
import { buildOpenCodeEnv, openCodeStateDirs } from './env.ts';
import { isTerminalRetry, openCodeErrorFrom } from './errors.ts';
import { openCodeToolCall, OpenCodeTurnTranslator } from './events.ts';
import { createOpenCodeCatalogSource, createOpenCodeHarnessModels, openCodeCatalogModels } from './models.ts';
import { compareVersions } from './server.ts';
import { openCodeModelRef, openCodeQuestionAnswers } from './session.ts';

describe('openCodeErrorFrom', () => {
  it('reads the free allowance running out as a usage limit', () => {
    const error = openCodeErrorFrom({
      name: 'APIError',
      data: {
        statusCode: 429,
        message: 'Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going',
      },
    });
    expect(error.kind).toBe('rate_limit');
    expect(error.message).toContain('Free usage limit reached');
  });

  it('tells a missing model, a refused key and an overloaded provider apart', () => {
    expect(openCodeErrorFrom({ name: 'APIError', data: { message: 'Upstream request failed: Model is unavailable.' } }).kind).toBe('model_unavailable');
    expect(openCodeErrorFrom({ name: 'ProviderAuthError', data: { message: 'bad key' } }).kind).toBe('auth');
    expect(openCodeErrorFrom({ name: 'APIError', data: { message: 'boom', statusCode: 503 } }).kind).toBe('overloaded');
    expect(openCodeErrorFrom({ name: 'ContextOverflowError', data: { message: 'too long' } }).kind).toBe('context');
    expect(openCodeErrorFrom({ name: 'UnknownError', data: { message: 'odd' } }).kind).toBe('unknown');
  });

  it('reads the message out of a response body', () => {
    const error = openCodeErrorFrom({ name: 'APIError', data: { responseBody: '{"type":"error","error":{"type":"FreeUsageLimitError","message":"Free usage limit reached."}}' } });
    expect(error.kind).toBe('rate_limit');
  });

  it('stops retrying what no retry gets past', () => {
    expect(isTerminalRetry('Free usage limit reached.')).toBe(true);
    expect(isTerminalRetry('Provider is overloaded, retrying')).toBe(false);
  });
});

describe('the run config', () => {
  it('asks before edits, commands and leaving the checkout by default; never allows everything', () => {
    const rules = openCodePermissionRules({});
    expect(rules).toMatchObject({ edit: 'ask', bash: 'ask', external_directory: 'ask', doom_loop: 'ask', read: 'allow', webfetch: 'allow' });
    expect(openCodePermissionRules({ edit: 'allow', bash: 'allow' }).external_directory).toBe('ask');
  });

  it('refuses what an unattended run cannot ask, unless it parks', () => {
    expect(openCodePermissionRules({ unattended: true })).toMatchObject({ edit: 'deny', bash: 'deny', external_directory: 'deny' });
    expect(openCodePermissionRules({ unattended: true, parkAsks: true })).toMatchObject({ edit: 'ask', bash: 'ask' });
  });

  it('asks about the tools asked about on every call, under OpenCode tool ids', () => {
    expect(openCodeToolIdForTranscriptName('mcp__factory__factory_retry_decision')).toBe('factory_factory_retry_decision');
    expect(openCodePermissionRules({ askEachTime: ['mcp__factory__factory_retry_decision'] }).factory_factory_retry_decision).toBe('ask');
  });

  it('mounts the Factory MCP server with its token and shares nothing', () => {
    const config = JSON.parse(openCodeConfigContent({ policy: {}, mcpServers: { factory: { url: 'https://f/mcp', headers: { 'x-token': 't' } } } }));
    expect(config).toMatchObject({ share: 'disabled', autoupdate: false, mcp: { factory: { type: 'remote', url: 'https://f/mcp', headers: { 'x-token': 't' }, enabled: true, oauth: false } } });
  });

  it('keeps the host credentials and its XDG folders out of the environment', () => {
    const env = buildOpenCodeEnv(
      { PATH: '/bin', HOME: '/h', OPENCODE_API_KEY: 'k', ANTHROPIC_API_KEY: 'a', XDG_CONFIG_HOME: '/h/.config', LC_ALL: 'C' },
      { dirs: openCodeStateDirs('/s', '/c'), configContent: '{}', password: 'p' },
    );
    expect(env).toMatchObject({ PATH: '/bin', HOME: '/h', LC_ALL: 'C', XDG_CONFIG_HOME: '/s/config', XDG_DATA_HOME: '/s/data', XDG_CACHE_HOME: '/c', OPENCODE_SERVER_PASSWORD: 'p', OPENCODE_DISABLE_CLAUDE_CODE: '1' });
    expect(env.OPENCODE_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });
});

describe('openCodeToolCall', () => {
  it("names OpenCode's tools as the Factory's own", () => {
    expect(openCodeToolCall('bash', { command: 'ls', description: 'list' })).toEqual({ toolName: 'execute_command', input: { command: 'ls', description: 'list' } });
    expect(openCodeToolCall('edit', { filePath: '/a', oldString: 'x', newString: 'y' })).toEqual({ toolName: 'string_replace_lsp', input: { path: '/a', old_string: 'x', new_string: 'y' } });
    expect(openCodeToolCall('read', { filePath: '/a' })).toEqual({ toolName: 'view', input: { path: '/a' } });
    expect(openCodeToolCall('todowrite', { todos: [{ content: 'one', status: 'in_progress' }] })).toEqual({
      toolName: 'task_write',
      input: { todos: [{ content: 'one', status: 'in_progress', activeForm: 'one' }] },
    });
    expect(openCodeToolCall('factory_factory_bound_work_item', { a: 1 }, ['factory'])).toEqual({ toolName: 'mcp__factory__factory_bound_work_item', input: { a: 1 } });
    expect(openCodeToolCall('something_else', {}, ['factory']).toolName).toBe('something_else');
  });
});

describe('OpenCodeTurnTranslator', () => {
  const sid = 'ses_root';

  it("skips the person's own message, streams and settles the reply, and sums usage", () => {
    const t = new OpenCodeTurnTranslator({ sessionId: sid });
    t.handle({ type: 'message.updated', properties: { sessionID: sid, info: { id: 'msg_u', role: 'user' } } });
    expect(t.handle({ type: 'message.part.updated', properties: { sessionID: sid, part: { id: 'p_u', messageID: 'msg_u', sessionID: sid, type: 'text', text: 'hi', time: { start: 1, end: 2 } } } }).entries).toEqual([]);
    t.handle({ type: 'message.updated', properties: { sessionID: sid, info: { id: 'msg_a', role: 'assistant' } } });
    t.handle({ type: 'message.part.updated', properties: { sessionID: sid, part: { id: 'p_r', messageID: 'msg_a', sessionID: sid, type: 'reasoning', text: '', time: { start: 1 } } } });
    expect(t.handle({ type: 'message.part.delta', properties: { sessionID: sid, messageID: 'msg_a', partID: 'p_r', field: 'text', delta: 'hmm' } }).entries).toEqual([{ kind: 'thinking_delta', text: 'hmm' }]);
    expect(t.handle({ type: 'message.part.updated', properties: { sessionID: sid, part: { id: 'p_r', messageID: 'msg_a', sessionID: sid, type: 'reasoning', text: 'hmm', time: { start: 1, end: 2 } } } }).entries).toEqual([
      { kind: 'thinking', text: 'hmm', messageId: 'p_r' },
    ]);
    const step = t.handle({ type: 'message.part.updated', properties: { sessionID: sid, part: { id: 'p_s', messageID: 'msg_a', sessionID: sid, type: 'step-finish', tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 5, write: 0 } } } } });
    expect(step.usage).toEqual({ promptTokens: 10, completionTokens: 2, reasoningTokens: 0, cachedInputTokens: 5, cacheCreationInputTokens: 0, totalTokens: 17 });
    expect(t.handle({ type: 'session.idle', properties: { sessionID: sid } }).idle).toBe(true);
    expect(t.outcome()).toEqual({ kind: 'complete' });
  });

  it('ignores events of other sessions, but nests a subagent session under its call', () => {
    const t = new OpenCodeTurnTranslator({ sessionId: sid });
    expect(t.handle({ type: 'session.idle', properties: { sessionID: 'ses_other' } }).idle).toBeUndefined();
    t.handle({ type: 'message.part.updated', properties: { sessionID: sid, part: { id: 'p_task', messageID: 'm', sessionID: sid, type: 'tool', tool: 'task', callID: 'call_task', state: { status: 'running', input: { description: 'look', prompt: 'look around' }, metadata: { sessionId: 'ses_child' } } } } });
    const nested = t.handle({ type: 'message.part.updated', properties: { sessionID: 'ses_child', part: { id: 'p_c', messageID: 'mc', sessionID: 'ses_child', type: 'tool', tool: 'read', callID: 'call_read', state: { status: 'running', input: { filePath: '/x' } } } } });
    expect(nested.entries).toEqual([{ kind: 'tool_call', toolCallId: 'call_read', toolName: 'view', input: { path: '/x' }, parentToolCallId: 'call_task' }]);
  });

  it('ends a planning turn on a plan gate', () => {
    const t = new OpenCodeTurnTranslator({ sessionId: sid, planning: true });
    t.handle({ type: 'message.part.updated', properties: { sessionID: sid, part: { id: 'p_t', messageID: 'msg_a', sessionID: sid, type: 'text', text: '## The plan\nsteps', time: { start: 1, end: 2 } } } });
    const idle = t.handle({ type: 'session.idle', properties: { sessionID: sid } });
    expect(idle.entries.map(entry => entry.kind)).toEqual(['tool_call', 'plan']);
    expect(t.outcome()).toMatchObject({ kind: 'gate', gate: { toolName: 'submit_plan', title: 'The plan' } });
  });

  it('reads an aborted message as no failure', () => {
    const t = new OpenCodeTurnTranslator({ sessionId: sid });
    t.handle({ type: 'session.error', properties: { sessionID: sid, error: { name: 'MessageAbortedError', data: { message: 'aborted' } } } });
    t.handle({ type: 'session.idle', properties: { sessionID: sid } });
    expect(t.outcome()).toEqual({ kind: 'complete' });
  });
});

describe('the catalog', () => {
  const providers: OpenCodeProviderList = {
    all: [
      {
        id: 'opencode',
        models: {
          'big-pickle': { id: 'big-pickle', name: 'Big Pickle', status: 'active', cost: { input: 0, output: 0 } },
          'beam-free': { id: 'beam-free', name: 'Beam Free', status: 'active', cost: { input: 0, output: 0 }, variants: { low: {}, high: {} } },
          'old-free': { id: 'old-free', name: 'Old Free', status: 'deprecated', cost: { input: 0, output: 0 } },
          'gpt-paid': { id: 'gpt-paid', name: 'Paid', status: 'active', cost: { input: 1, output: 2 } },
        },
      },
      { id: 'anthropic', models: { x: { id: 'x', cost: { input: 0, output: 0 } } } },
    ],
  };

  it("offers OpenCode's free models alone, marked free, Big Pickle by default", () => {
    const models = openCodeCatalogModels(providers);
    expect(models.map(model => [model.slug, model.badge, model.isDefault ?? false])).toEqual([
      ['opencode/beam-free', 'free', false],
      ['opencode/big-pickle', 'free', true],
    ]);
    expect(models[0]!.capabilities?.optionDescriptors?.[0]).toMatchObject({ id: 'effort', options: [{ id: 'low' }, { id: 'high' }] });
  });

  it('says the CLI is missing, and compiles a pick into the turn', async () => {
    const missing = createOpenCodeCatalogSource({ installed: () => false, probe: async () => ({ providers }) });
    expect(await missing()).toMatchObject({ available: false, needsSetup: true });
    const catalog = createOpenCodeCatalogSource({ installed: () => true, probe: async () => ({ providers, version: '1.19.5' }) });
    const settings = new Map<string, unknown>();
    const session = { thread: { getSetting: async ({ key }: { key: string }) => settings.get(key), setSetting: async ({ key, value }: { key: string; value: unknown }) => void settings.set(key, value) } };
    const models = createOpenCodeHarnessModels({
      owns: async () => true,
      getSession: async () => session,
      defaults: async () => null,
      settingKeys: { selection: 'sel', lastSelection: 'last' },
      catalog,
    });
    expect(await models.turnSelection(session)).toEqual({ model: 'opencode/big-pickle' });
    const checked = await models.check({ model: 'opencode/beam-free', options: [{ id: 'effort', value: 'high' }] }, { viewer: { userId: 'u', orgId: 'o' } });
    expect(checked.ok).toBe(true);
    if (checked.ok) await models.setSelection('s', checked.selection, { viewer: { userId: 'u', orgId: 'o' } });
    expect(await models.turnSelection(session)).toMatchObject({ model: 'opencode/beam-free', variant: 'high', modelSwitch: { from: { model: 'opencode/big-pickle' } } });
    expect((await models.check({ model: 'opencode/gpt-paid' }, { viewer: { userId: 'u', orgId: 'o' } })).ok).toBe(false);
  });
});

describe('helpers', () => {
  it('splits a model ref, compares versions and splits a card of several answers', () => {
    expect(openCodeModelRef('opencode/big-pickle')).toEqual({ providerID: 'opencode', modelID: 'big-pickle' });
    expect(openCodeModelRef('nope')).toBeUndefined();
    expect(compareVersions('1.19.5', '1.14.19')).toBeGreaterThan(0);
    expect(compareVersions('1.14.2', '1.14.19')).toBeLessThan(0);
    expect(openCodeQuestionAnswers([{ question: 'A?' }], 'yes')).toEqual([['yes']]);
  });

  it('parses a server-sent event stream across chunk boundaries', async () => {
    const encoder = new TextEncoder();
    const chunks = ['data: {"type":"a","properties":{"x":1}}\n', '\ndata: {"type":"b",', '"properties":{}}\n\n: keep-alive\n\n'];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    const events = [];
    for await (const event of parseServerSentEvents(body)) events.push(event.type);
    expect(events).toEqual(['a', 'b']);
  });
});
