import { describe, expect, it } from 'vitest';

import { fixture } from './__fixtures__/fake-claude.ts';
import { classifyFailure, ClaudeCodeError, parseResetTime } from './errors.ts';
import {
  PLAN_GATE_TOOL,
  toTokenUsage,
  TurnTranslator,
  type ClaudeTranscriptEntry,
  type TurnOutcome,
} from './events.ts';
import { parseStreamLine } from './stream.ts';

function play(name: string) {
  const translator = new TurnTranslator();
  const transcript: ClaudeTranscriptEntry[] = [];
  for (const line of fixture(name)) {
    const message = parseStreamLine(line);
    if (message) transcript.push(...translator.push(message));
  }
  return { translator, transcript };
}

const SESSION = '9f0c1a52-6b1e-4d6a-9a43-2f3b8f0e7c11';

function line(json: Record<string, unknown>) {
  return parseStreamLine(JSON.stringify(json))!;
}

function failure(outcome: TurnOutcome) {
  expect(outcome.kind).toBe('error');
  const { error } = outcome as { error: ClaudeCodeError };
  expect(error).toBeInstanceOf(ClaudeCodeError);
  return { kind: error.kind, message: error.message, status: error.status, resetsAt: error.resetsAt };
}

describe('TurnTranslator', () => {
  it('builds the transcript and completes a successful turn', () => {
    const { translator, transcript } = play('turn-complete.jsonl');

    expect(translator.sessionId).toBe('9f0c1a52-6b1e-4d6a-9a43-2f3b8f0e7c11');
    expect(transcript.map(entry => entry.kind)).toEqual(['init', 'thinking', 'tool_call', 'tool_result', 'text', 'result']);
    expect(transcript[2]).toEqual({
      kind: 'tool_call',
      toolCallId: 'toolu_01Read',
      toolName: 'Bash',
      input: { command: 'cat README.md', description: 'Show the README' },
    });
    expect(translator.outcome({ exitCode: 0, stderr: '' })).toEqual({
      kind: 'complete',
      text: 'The README already describes the project; I added a usage section.',
    });
  });

  it('reports usage once per model message, using its latest copy', () => {
    const { translator } = play('turn-complete.jsonl');

    expect(translator.usageSteps()).toEqual([
      {
        promptTokens: 4 + 13502 + 2311,
        completionTokens: 87,
        totalTokens: 4 + 13502 + 2311 + 87,
        cachedInputTokens: 13502,
        cacheCreationInputTokens: 2311,
        cacheCreationInputTokens5m: 2311,
        cacheCreationInputTokens1h: 0,
      },
      {
        promptTokens: 6 + 15813 + 120,
        completionTokens: 31,
        totalTokens: 6 + 15813 + 120 + 31,
        cachedInputTokens: 15813,
        cacheCreationInputTokens: 120,
      },
    ]);
  });

  it('falls back to the result usage when no message carried any', () => {
    const translator = new TurnTranslator();
    translator.push(parseStreamLine(fixture('turn-complete.jsonl')[5]!)!);
    expect(translator.usageSteps()).toEqual([
      toTokenUsage({ input_tokens: 10, cache_creation_input_tokens: 2431, cache_read_input_tokens: 29315, output_tokens: 118 }),
    ]);
  });

  function playUntilGate(name: string) {
    const translator = new TurnTranslator();
    const transcript: ClaudeTranscriptEntry[] = [];
    for (const line of fixture(name)) {
      transcript.push(...translator.push(parseStreamLine(line)!));
      if (translator.gate) break;
    }
    return { translator, transcript };
  }

  it('turns a submit_plan call on the gate server into a plan gate', () => {
    const { translator, transcript } = playUntilGate('turn-submit-plan.jsonl');

    expect(translator.gate).toEqual({
      toolCallId: 'toolu_03Gate',
      toolName: 'mcp__factory_gate__submit_plan',
      title: 'README usage section',
      plan: '1. Add a usage section to README.md\n2. Link it from src/index.ts docs',
    });
    expect(transcript.slice(-2)).toEqual([
      {
        kind: 'tool_call',
        toolCallId: 'toolu_03Gate',
        toolName: 'mcp__factory_gate__submit_plan',
        input: { title: 'README usage section', plan: expect.stringContaining('usage section') },
      },
      {
        kind: 'plan',
        toolCallId: 'toolu_03Gate',
        toolName: 'mcp__factory_gate__submit_plan',
        title: 'README usage section',
        plan: expect.stringContaining('usage section'),
      },
    ]);
    expect(translator.outcome({ exitCode: null, stderr: '' })).toMatchObject({ kind: 'gate' });
  });

  it('still treats an ExitPlanMode call as a plan gate', () => {
    const { translator, transcript } = playUntilGate('turn-plan.jsonl');

    expect(translator.gate).toEqual({
      toolCallId: 'toolu_02Plan',
      toolName: 'ExitPlanMode',
      plan: '1. Add a usage section to README.md\n2. Link it from src/index.ts docs',
    });
    expect(transcript.at(-1)).toMatchObject({ kind: 'plan', toolCallId: 'toolu_02Plan' });
    expect(translator.outcome({ exitCode: null, stderr: '' })).toMatchObject({ kind: 'gate' });
  });

  it('ignores a submit_plan call on another MCP server', () => {
    const translator = new TurnTranslator();
    translator.push({
      type: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_x', name: 'mcp__other__submit_plan', input: { plan: 'x' } }],
      raw: {},
    });
    expect(translator.gate).toBeUndefined();
  });

  it('ignores a subagent plan', () => {
    const translator = new TurnTranslator();
    translator.push({
      type: 'assistant',
      parentToolUseId: 'toolu_task',
      content: [
        { type: 'tool_use', id: 'toolu_sub', name: 'ExitPlanMode', input: { plan: 'x' } },
        { type: 'tool_use', id: 'toolu_sub2', name: 'mcp__factory_gate__submit_plan', input: { plan: 'x' } },
      ],
      raw: {},
    });
    expect(translator.gate).toBeUndefined();
  });

  it('turns a call the permission tool refused for a person into a permission request (recorded live)', () => {
    const { translator, transcript } = play('turn-permission.jsonl');
    const request = {
      toolCallId: 'toolu_01EeMtJW2FWqSJ5sKMZmuQub',
      toolName: 'Write',
      input: { file_path: '/work/card-1/x.txt', content: '' },
    };
    expect(translator.permission).toEqual(request);
    // The refusal is not the call's result: the call waits for the person.
    expect(transcript.map(entry => entry.kind)).toEqual(['init', 'tool_call', 'permission', 'text', 'result']);
    expect(translator.outcome({ exitCode: 0, stderr: '' })).toEqual({ kind: 'permission', request });
  });

  it('keeps an ordinary refused call as its result', () => {
    const translator = new TurnTranslator();
    translator.push({ type: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }], raw: {} });
    const entries = translator.push({
      type: 'user',
      content: [{ type: 'tool_result', toolUseId: 't1', content: 'Permission denied.', isError: true }],
      raw: {},
    });
    expect(entries).toEqual([{ kind: 'tool_result', toolCallId: 't1', content: 'Permission denied.', isError: true }]);
    expect(translator.permission).toBeUndefined();
  });

  it('streams partial text deltas when the CLI sends them', () => {
    const { transcript } = play('turn-partial.jsonl');
    expect(transcript.filter(entry => entry.kind === 'text_delta')).toEqual([
      { kind: 'text_delta', text: 'Hel' },
      { kind: 'text_delta', text: 'lo' },
    ]);
    expect(transcript).toContainEqual({ kind: 'stdout', text: 'not json at all' });
  });

  it('classifies a usage-limit turn as a rate limit with its reset time', () => {
    const { translator } = play('turn-rate-limit.jsonl');
    const now = new Date(1793100000 * 1000);
    const outcome = translator.outcome({ exitCode: 1, stderr: '' }, now);

    expect(outcome.kind).toBe('error');
    const error = (outcome as { error: ClaudeCodeError }).error;
    expect(error).toBeInstanceOf(ClaudeCodeError);
    expect(error.kind).toBe('rate_limit');
    expect(error.retryable).toBe(true);
    expect(error.resetsAt).toEqual(new Date(1793116800 * 1000));
    expect(error.retryAfter).toBe(16800 * 1000);
    expect(error.message).toContain('5-hour limit reached');
  });

  it('fails a turn that exited without a result', () => {
    const translator = new TurnTranslator();
    const outcome = translator.outcome({ exitCode: 1, stderr: 'Error: something broke\n' });
    expect(outcome).toMatchObject({ kind: 'error', error: { kind: 'failed', message: 'Error: something broke' } });
  });
});

describe('classifyFailure', () => {
  const now = new Date('2026-10-27T12:00:00Z');

  it.each([
    [{ status: 429, text: 'API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}' }, 'rate_limit'],
    [{ text: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}' }, 'overloaded'],
    [{ text: 'Invalid API key · Please run /login' }, 'auth'],
    [{ errorMarker: 'authentication_failed', text: 'OAuth token has expired' }, 'auth'],
    [{ errors: ['No conversation found with session ID: abc'] }, 'unknown_session'],
    [{ subtype: 'error_max_turns' }, 'max_turns'],
    [{ exitCode: 137 }, 'process'],
  ] as const)('classifies %j as %s', (evidence, kind) => {
    expect(classifyFailure(evidence, now).kind).toBe(kind);
  });

  it('reads the legacy epoch reset marker and wall-clock resets in a zone', () => {
    expect(parseResetTime('Claude AI usage limit reached|1793116800', now)).toEqual(new Date(1793116800 * 1000));
    // 3pm New York on 2026-10-27 is 19:00 UTC (EDT).
    expect(parseResetTime('5-hour limit reached ∙ resets 3pm (America/New_York)', now)).toEqual(
      new Date('2026-10-27T19:00:00Z'),
    );
    // Already past today: tomorrow.
    expect(parseResetTime('weekly limit reached, resets at 7:30 am (UTC)', now)).toEqual(new Date('2026-10-28T07:30:00Z'));
    expect(parseResetTime('nothing to see', now)).toBeUndefined();
  });

  it('carries the reset time on a usage-limit error', () => {
    const error = classifyFailure({ text: 'Claude usage limit reached. Your limit will reset at 3pm (UTC).' }, now);
    expect(error).toMatchObject({ kind: 'rate_limit', resetsAt: new Date('2026-10-27T15:00:00Z'), retryAfter: 3 * 3_600_000 });
  });
});

describe('toTokenUsage', () => {
  it('leaves out cache counts the CLI did not report', () => {
    expect(toTokenUsage({ input_tokens: 5, output_tokens: 2 })).toStrictEqual({
      promptTokens: 5,
      completionTokens: 2,
      totalTokens: 7,
    });
  });

  it('keeps only the cache-creation split the CLI reported', () => {
    expect(toTokenUsage({ output_tokens: 1, cache_creation: { ephemeral_1h_input_tokens: 40 } })).toStrictEqual({
      promptTokens: 0,
      completionTokens: 1,
      totalTokens: 1,
      cacheCreationInputTokens1h: 40,
    });
    expect(toTokenUsage({ cache_creation: { ephemeral_5m_input_tokens: 30 } })).toStrictEqual({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cacheCreationInputTokens5m: 30,
    });
  });
});

describe('TurnTranslator transcript', () => {
  it('records the init entry with its model and permission mode and marks the turn started', () => {
    const translator = new TurnTranslator();
    expect(translator.started).toBe(false);
    expect(translator.push(parseStreamLine(fixture('turn-complete.jsonl')[0]!)!)).toEqual([
      { kind: 'init', sessionId: SESSION, model: 'claude-sonnet-4-6', permissionMode: 'acceptEdits' },
    ]);
    expect(translator.started).toBe(true);
  });

  it('records an init without a model or permission mode as just its session', () => {
    const translator = new TurnTranslator();
    expect(translator.push(line({ type: 'system', subtype: 'init', session_id: SESSION }))).toStrictEqual([
      { kind: 'init', sessionId: SESSION },
    ]);
  });

  it('does not start the turn on other system messages or an init without a session', () => {
    const translator = new TurnTranslator();
    expect(translator.push(line({ type: 'system', subtype: 'compact_boundary', session_id: SESSION }))).toEqual([]);
    expect(translator.push(line({ type: 'system', subtype: 'init' }))).toEqual([]);
    expect(translator.started).toBe(false);
    expect(translator.sessionId).toBe(SESSION);
  });

  it('keeps the session id when later messages carry none', () => {
    const translator = new TurnTranslator();
    translator.push(line({ type: 'system', subtype: 'init', session_id: SESSION }));
    translator.push(line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hi' }] } }));
    translator.push({ type: 'user', sessionId: undefined, content: [], raw: {} } as never);
    expect(translator.sessionId).toBe(SESSION);
  });

  it('tags text and thinking with their message id and subagent call', () => {
    const translator = new TurnTranslator();
    const entries = translator.push(
      line({
        type: 'assistant',
        parent_tool_use_id: 'toolu_task',
        message: {
          id: 'msg_sub',
          content: [
            { type: 'thinking', thinking: 'Look first.' },
            { type: 'text', text: 'Found it.' },
            { type: 'tool_use', id: 'toolu_sub', name: 'Read', input: { file_path: 'a.ts' } },
          ],
        },
      }),
    );
    expect(entries).toStrictEqual([
      { kind: 'thinking', text: 'Look first.', messageId: 'msg_sub', parentToolCallId: 'toolu_task' },
      { kind: 'text', text: 'Found it.', messageId: 'msg_sub', parentToolCallId: 'toolu_task' },
      {
        kind: 'tool_call',
        toolCallId: 'toolu_sub',
        toolName: 'Read',
        input: { file_path: 'a.ts' },
        parentToolCallId: 'toolu_task',
      },
    ]);
  });

  it('records text without a message id when the CLI gave none', () => {
    const translator = new TurnTranslator();
    expect(translator.push(line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hi' }] } }))).toStrictEqual([
      { kind: 'text', text: 'Hi' },
    ]);
  });

  it('skips empty text and thinking blocks and blocks it does not know', () => {
    const translator = new TurnTranslator();
    const entries = translator.push(
      line({
        type: 'assistant',
        message: {
          id: 'msg_1',
          content: [
            { type: 'text', text: '' },
            { type: 'thinking', thinking: '' },
            { type: 'redacted_thinking', data: 'xyz' },
          ],
        },
      }),
    );
    expect(entries).toEqual([]);
  });

  it('records user text, tool results and subagent tool results, skipping empty and unknown blocks', () => {
    const translator = new TurnTranslator();
    expect(
      translator.push(
        line({
          type: 'user',
          message: {
            content: [
              { type: 'text', text: 'Please continue.' },
              { type: 'text', text: '' },
              { type: 'image', source: {} },
              { type: 'tool_result', tool_use_id: 't1', content: 'ok', is_error: false },
            ],
          },
        }),
      ),
    ).toStrictEqual([
      { kind: 'user', text: 'Please continue.' },
      { kind: 'tool_result', toolCallId: 't1', content: 'ok', isError: false },
    ]);
    expect(
      translator.push(
        line({
          type: 'user',
          parent_tool_use_id: 'toolu_task',
          message: {
            content: [
              { type: 'text', text: 'Search the repo.' },
              { type: 'tool_result', tool_use_id: 't2', content: 'boom', is_error: true },
            ],
          },
        }),
      ),
    ).toStrictEqual([
      { kind: 'user', text: 'Search the repo.', parentToolCallId: 'toolu_task' },
      { kind: 'tool_result', toolCallId: 't2', content: 'boom', isError: true, parentToolCallId: 'toolu_task' },
    ]);
  });

  it('records the whole partial-message stream: deltas, the full text, stray stdout and the result', () => {
    const { transcript } = play('turn-partial.jsonl');
    expect(transcript).toStrictEqual([
      { kind: 'init', sessionId: SESSION, model: 'claude-sonnet-4-6', permissionMode: 'default' },
      { kind: 'text_delta', text: 'Hel' },
      { kind: 'text_delta', text: 'lo' },
      { kind: 'text', text: 'Hello', messageId: 'msg_03A' },
      { kind: 'stdout', text: 'not json at all' },
      { kind: 'result', subtype: 'success', isError: false, text: 'Hello', costUsd: 0.0004, durationMs: 900, numTurns: 1 },
    ]);
  });

  it('streams thinking deltas and subagent deltas, ignoring other delta kinds', () => {
    const translator = new TurnTranslator();
    const delta = (value: Record<string, unknown>, parent?: string) =>
      translator.push(
        line({
          type: 'stream_event',
          event: { type: 'content_block_delta', index: 0, delta: value },
          ...(parent ? { parent_tool_use_id: parent } : {}),
        }),
      );
    expect(delta({ type: 'thinking_delta', thinking: 'Hmm' })).toStrictEqual([{ kind: 'thinking_delta', text: 'Hmm' }]);
    expect(delta({ type: 'thinking_delta', thinking: 'sub' }, 'toolu_task')).toStrictEqual([
      { kind: 'thinking_delta', text: 'sub', parentToolCallId: 'toolu_task' },
    ]);
    expect(delta({ type: 'text_delta', text: 'sub' }, 'toolu_task')).toStrictEqual([
      { kind: 'text_delta', text: 'sub', parentToolCallId: 'toolu_task' },
    ]);
    expect(delta({ type: 'input_json_delta', partial_json: '{"a"' })).toEqual([]);
    expect(delta({ type: 'signature_delta', signature: 'Eq' })).toEqual([]);
    expect(delta({ type: 'text_delta', text: 7 })).toEqual([]);
    expect(delta({ type: 'thinking_delta', thinking: 7 })).toEqual([]);
  });

  it('ignores stream events that are not content deltas or carry no delta', () => {
    const translator = new TurnTranslator();
    expect(translator.push(line({ type: 'stream_event', event: { type: 'content_block_delta', index: 0 } }))).toEqual([]);
    expect(
      translator.push(
        line({ type: 'stream_event', event: { type: 'message_delta', delta: { type: 'text_delta', text: 'x' } } }),
      ),
    ).toEqual([]);
  });

  it('records nothing for rate-limit events, retries and unknown messages', () => {
    const translator = new TurnTranslator();
    expect(
      translator.push(
        line({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1793290933 }, session_id: SESSION }),
      ),
    ).toEqual([]);
    expect(
      translator.push(line({ type: 'system', subtype: 'api_retry', attempt: 1, error_status: 529, error: 'overloaded' })),
    ).toEqual([]);
    expect(translator.push(line({ type: 'some_future_event' }))).toEqual([]);
  });

  it('records a result with only the fields the CLI sent', () => {
    const translator = new TurnTranslator();
    expect(translator.sawResult).toBe(false);
    expect(translator.push(line({ type: 'result', subtype: 'error_during_execution', is_error: true }))).toStrictEqual([
      { kind: 'result', subtype: 'error_during_execution', isError: true },
    ]);
    expect(translator.sawResult).toBe(true);
  });
});

describe('TurnTranslator plan gate', () => {
  it('names the plan gate submit_plan for the dispatcher', () => {
    expect(PLAN_GATE_TOOL).toBe('submit_plan');
  });

  it('keeps only a string plan and a non-blank title', () => {
    const translator = new TurnTranslator();
    translator.push({
      type: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_p', name: 'ExitPlanMode', input: { plan: 42, title: '   ' } }],
      raw: {},
    });
    expect(translator.gate).toStrictEqual({ toolCallId: 'toolu_p', toolName: 'ExitPlanMode' });
  });

  it('gates on a plan call that has no input', () => {
    const translator = new TurnTranslator();
    const entries = translator.push({
      type: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_p', name: 'mcp__factory_gate__submit_plan', input: undefined }],
      raw: {},
    });
    expect(translator.gate).toStrictEqual({ toolCallId: 'toolu_p', toolName: 'mcp__factory_gate__submit_plan' });
    expect(entries.at(-1)).toStrictEqual({
      kind: 'plan',
      toolCallId: 'toolu_p',
      toolName: 'mcp__factory_gate__submit_plan',
    });
  });
});

describe('TurnTranslator permission requests', () => {
  const pending = (toolUseId: string, parent?: string) =>
    line({
      type: 'user',
      ...(parent ? { parent_tool_use_id: parent } : {}),
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolUseId,
            content: '[factory:permission-pending] Using it needs a person\'s permission.',
            is_error: true,
          },
        ],
      },
    });

  it('parks on the first pending call only', () => {
    const translator = new TurnTranslator();
    translator.push(
      line({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 't1', name: 'Write', input: { file_path: 'a' } },
            { type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: 'b' } },
          ],
        },
      }),
    );
    expect(translator.push(pending('t1'))).toStrictEqual([
      { kind: 'permission', toolCallId: 't1', toolName: 'Write', input: { file_path: 'a' } },
    ]);
    expect(translator.push(pending('t2'))).toEqual([]);
    expect(translator.permission).toStrictEqual({ toolCallId: 't1', toolName: 'Write', input: { file_path: 'a' } });
  });

  it('names a pending call it never saw as unknown', () => {
    const translator = new TurnTranslator();
    expect(translator.push(pending('t9'))).toStrictEqual([{ kind: 'permission', toolCallId: 't9', toolName: 'unknown' }]);
  });

  it('leaves out the input of a call that had none', () => {
    const translator = new TurnTranslator();
    translator.push({ type: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: undefined }], raw: {} });
    translator.push(pending('t1'));
    expect(translator.permission).toStrictEqual({ toolCallId: 't1', toolName: 'Bash' });
  });

  it('carries the subagent call a pending request came from', () => {
    const translator = new TurnTranslator();
    translator.push(
      line({
        type: 'assistant',
        parent_tool_use_id: 'toolu_task',
        message: { content: [{ type: 'tool_use', id: 't1', name: 'Write', input: { file_path: 'a' } }] },
      }),
    );
    expect(translator.push(pending('t1', 'toolu_task'))).toStrictEqual([
      { kind: 'permission', toolCallId: 't1', toolName: 'Write', input: { file_path: 'a' }, parentToolCallId: 'toolu_task' },
    ]);
  });
});

describe('TurnTranslator usage', () => {
  it('counts each message without an id on its own and skips messages without usage', () => {
    const translator = new TurnTranslator();
    translator.push(line({ type: 'assistant', message: { content: [], usage: { input_tokens: 1, output_tokens: 2 } } }));
    translator.push(line({ type: 'assistant', message: { content: [], usage: { input_tokens: 3, output_tokens: 4 } } }));
    translator.push(line({ type: 'assistant', message: { id: 'msg_x', content: [{ type: 'text', text: 'x' }] } }));
    expect(translator.usageSteps()).toEqual([
      { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
      { promptTokens: 3, completionTokens: 4, totalTokens: 7 },
    ]);
  });

  it('falls back to the result usage when the messages carried none', () => {
    const translator = new TurnTranslator();
    translator.push(line({ type: 'assistant', message: { id: 'msg_x', content: [{ type: 'text', text: 'x' }] } }));
    translator.push(line({ type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 2, output_tokens: 1 } }));
    expect(translator.usageSteps()).toEqual([{ promptTokens: 2, completionTokens: 1, totalTokens: 3 }]);
  });

  it('reports no usage when neither the messages nor the result carried any', () => {
    const translator = new TurnTranslator();
    expect(translator.usageSteps()).toEqual([]);
    translator.push(line({ type: 'result', subtype: 'success', is_error: false }));
    expect(translator.usageSteps()).toEqual([]);
  });
});

describe('TurnTranslator API retries', () => {
  const retry = (fields: Record<string, unknown>) => line({ type: 'system', subtype: 'api_retry', session_id: SESSION, ...fields });

  it.each([
    [{ attempt: 1, error_status: 401, error: 'authentication_failed' }, true],
    [{ attempt: 1, error: 'authentication_failed' }, true],
    [{ attempt: 1, error_status: 401 }, true],
    [{ attempt: 1, error_status: 403 }, true],
    [{ attempt: 1, error_status: 429, error: 'rate_limit' }, false],
    [{ attempt: 1, error_status: 529, error: 'overloaded' }, false],
  ] as const)('treats a retry of %j as a refused account: %s', (fields, refused) => {
    const translator = new TurnTranslator();
    translator.push(retry(fields));
    expect(translator.accountRefused).toBe(refused);
  });

  it('does not treat a turn without retries as a refused account', () => {
    expect(new TurnTranslator().accountRefused).toBe(false);
    expect(new TurnTranslator().rateLimitRetries).toBe(0);
  });

  it.each([
    [{ attempt: 3, error_status: 429, error: 'rate_limit' }, 3],
    [{ attempt: 2, error: 'rate_limit' }, 2],
    [{ attempt: 4, error_status: 429 }, 4],
    [{ error: 'rate_limit' }, 1],
    [{ attempt: 5, error_status: 529, error: 'overloaded' }, 0],
    [{ attempt: 5, error_status: 401, error: 'authentication_failed' }, 0],
  ] as const)('counts rate-limit retries of %j as %i', (fields, count) => {
    const translator = new TurnTranslator();
    translator.push(retry(fields));
    expect(translator.rateLimitRetries).toBe(count);
  });

  it('classifies a turn that died retrying an overloaded API with its status', () => {
    const translator = new TurnTranslator();
    translator.push(retry({ attempt: 10, error_status: 529, error: 'overloaded' }));
    expect(failure(translator.outcome({ exitCode: 1, stderr: '' }))).toEqual({
      kind: 'overloaded',
      message: 'Claude is overloaded.',
      status: 529,
    });
  });

  it('classifies a turn that died retrying from the retry error alone', () => {
    const translator = new TurnTranslator();
    translator.push(retry({ attempt: 2, error: 'rate_limit' }));
    expect(failure(translator.outcome({ exitCode: 1, stderr: '' }))).toEqual({
      kind: 'rate_limit',
      message: 'Claude Code hit a rate limit.',
    });
  });

  it('ignores a retry status that is not a number', () => {
    const translator = new TurnTranslator();
    translator.push(retry({ attempt: 1, error_status: null, error: 'connection_error' }));
    expect(failure(translator.outcome({ exitCode: 1, stderr: 'fetch failed' }))).toEqual({
      kind: 'failed',
      message: 'fetch failed',
    });
  });

  it('prefers the result status over the retry status', () => {
    const translator = new TurnTranslator();
    translator.push(retry({ attempt: 1, error_status: 529, error: 'overloaded' }));
    translator.push(
      line({ type: 'result', subtype: 'success', is_error: true, result: 'API Error: 500 Internal error', api_error_status: 500 }),
    );
    expect(failure(translator.outcome({ exitCode: 1, stderr: '' }))).toEqual({
      kind: 'failed',
      message: 'API Error: 500 Internal error',
      status: 500,
    });
  });
});

describe('TurnTranslator outcome', () => {
  it('completes without text when the result carried none', () => {
    const translator = new TurnTranslator();
    translator.push(line({ type: 'result', subtype: 'success', is_error: false }));
    expect(translator.outcome({ exitCode: 0, stderr: '' })).toStrictEqual({ kind: 'complete' });
  });

  it('fails on a synthetic API-error message even without a result, using its marker and text', () => {
    const translator = new TurnTranslator();
    translator.push(
      line({
        type: 'assistant',
        error: 'authentication_failed',
        message: { id: 'synthetic', model: '<synthetic>', content: [{ type: 'text', text: 'Your organization disabled this key' }] },
      }),
    );
    expect(failure(translator.outcome({ exitCode: 1, stderr: '' }))).toEqual({
      kind: 'auth',
      message: 'Your organization disabled this key',
    });
  });

  it('fails a successful-looking result when an API-error message came first', () => {
    const translator = new TurnTranslator();
    translator.push(
      line({
        type: 'assistant',
        error: 'authentication_failed',
        message: { content: [{ type: 'text', text: 'Your organization disabled this key' }] },
      }),
    );
    translator.push(line({ type: 'result', subtype: 'success', is_error: false, result: 'Your organization disabled this key' }));
    expect(failure(translator.outcome({ exitCode: 1, stderr: '' }))).toEqual({
      kind: 'auth',
      message: 'Your organization disabled this key',
    });
  });

  it('joins the text blocks of an API-error message, one per line', () => {
    const translator = new TurnTranslator();
    translator.push({
      type: 'assistant',
      error: 'unknown',
      content: [
        { type: 'text', text: 'Request failed' },
        { type: 'thinking', thinking: 'internal' },
        { type: 'text', text: 'try again later' },
      ],
      raw: {},
    });
    expect(failure(translator.outcome({ exitCode: 1, stderr: '' }))).toEqual({
      kind: 'failed',
      message: 'Request failed\n\ntry again later',
    });
  });

  it('does not take ordinary assistant text as the failure', () => {
    const translator = new TurnTranslator();
    translator.push(line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Working on it' }] } }));
    translator.push(line({ type: 'result', subtype: 'error_during_execution', is_error: true }));
    expect(failure(translator.outcome({ exitCode: 1, stderr: '' }))).toEqual({
      kind: 'process',
      message: 'Claude Code exited with code 1.',
    });
  });

  it('classifies a result that hit the turn limit by its subtype', () => {
    const translator = new TurnTranslator();
    translator.push(line({ type: 'result', subtype: 'error_max_turns', is_error: true }));
    expect(failure(translator.outcome({ exitCode: 1, stderr: '' }))).toEqual({
      kind: 'max_turns',
      message: 'Claude Code hit its turn limit.',
    });
  });

  it('classifies a rejected rate limit with no wording as a rate limit', () => {
    const translator = new TurnTranslator();
    translator.push(line({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour' } }));
    expect(failure(translator.outcome({ exitCode: 1, stderr: '' }))).toEqual({
      kind: 'rate_limit',
      message: 'Claude Code hit a rate limit.',
    });
  });

  it('keeps the reset time of an earlier rejection when a later one has none', () => {
    const translator = new TurnTranslator();
    translator.push(line({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1793290933 } }));
    translator.push(line({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } }));
    expect(failure(translator.outcome({ exitCode: 1, stderr: '' }, new Date(1793280000 * 1000)))).toEqual({
      kind: 'rate_limit',
      message: 'Claude Code hit a rate limit.',
      resetsAt: new Date(1793290933 * 1000),
    });
  });

  it('does not blame a rate-limit warning for a turn that failed otherwise', () => {
    const translator = new TurnTranslator();
    translator.push(
      line({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', resetsAt: 1793290933, rateLimitType: 'five_hour' } }),
    );
    expect(failure(translator.outcome({ exitCode: 1, stderr: 'Error: something broke\n' }))).toEqual({
      kind: 'failed',
      message: 'Error: something broke',
    });
  });
});
