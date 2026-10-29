import { describe, expect, it } from 'vitest';

import { fixture } from './__fixtures__/fake-claude.ts';
import { createLineSplitter, parseStreamLine } from './stream.ts';

describe('parseStreamLine', () => {
  it('reads a whole turn: init, assistant blocks, tool results and the result', () => {
    const messages = fixture('turn-complete.jsonl').map(parseStreamLine);

    expect(messages[0]).toMatchObject({
      type: 'system',
      subtype: 'init',
      sessionId: '9f0c1a52-6b1e-4d6a-9a43-2f3b8f0e7c11',
      model: 'claude-sonnet-4-6',
      permissionMode: 'acceptEdits',
    });
    expect(messages[1]).toMatchObject({
      type: 'assistant',
      messageId: 'msg_01A',
      content: [{ type: 'thinking', thinking: expect.stringContaining('README') }],
      usage: { input_tokens: 4, cache_read_input_tokens: 13502, cache_creation: { ephemeral_5m_input_tokens: 2311 } },
    });
    expect(messages[2]).toMatchObject({
      type: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_01Read', name: 'Bash', input: { command: 'cat README.md' } }],
    });
    expect(messages[3]).toMatchObject({
      type: 'user',
      content: [{ type: 'tool_result', toolUseId: 'toolu_01Read', content: '# Demo\n\nA demo project.', isError: false }],
    });
    expect(messages[5]).toMatchObject({
      type: 'result',
      subtype: 'success',
      isError: false,
      totalCostUsd: 0.0213,
      numTurns: 3,
      usage: { input_tokens: 10, output_tokens: 118 },
    });
  });

  it('keeps unknown kinds and non-JSON output instead of failing the turn', () => {
    const messages = fixture('turn-partial.jsonl').map(parseStreamLine);

    expect(messages.find(message => message?.type === 'unknown')).toMatchObject({ raw: { type: 'some_future_event' } });
    expect(messages.find(message => message?.type === 'invalid')).toEqual({ type: 'invalid', line: 'not json at all' });
    expect(messages.filter(message => message?.type === 'stream_event')).toHaveLength(5);
    expect(parseStreamLine('   ')).toBeUndefined();
    expect(parseStreamLine('[1,2]')).toEqual({ type: 'invalid', line: '[1,2]' });
  });

  it('reads rate-limit events and error results', () => {
    const [, rateLimit, assistant, result] = fixture('turn-rate-limit.jsonl').map(parseStreamLine);
    expect(rateLimit).toMatchObject({
      type: 'rate_limit',
      status: 'rejected',
      rateLimitType: 'five_hour',
      resetsAt: new Date(1793116800 * 1000),
    });
    expect(assistant).toMatchObject({ type: 'assistant', error: 'rate_limit' });
    expect(result).toMatchObject({ type: 'result', isError: true });

    const [unknownSession] = fixture('turn-unknown-session.jsonl').map(parseStreamLine);
    expect(unknownSession).toMatchObject({
      type: 'result',
      subtype: 'error_during_execution',
      errors: [expect.stringContaining('No conversation found')],
    });
  });
});

describe('createLineSplitter', () => {
  it('reassembles lines split across chunks and flushes the last one', () => {
    const lines: string[] = [];
    const splitter = createLineSplitter(line => lines.push(line));
    splitter.push('{"a":');
    splitter.push('1}\r\n{"b"');
    splitter.push(':2}\n\n{"c":3}');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
    splitter.flush();
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });
});

describe('parseStreamLine message shapes', () => {
  const line = (value: unknown) => JSON.stringify(value);

  it('treats JSON that is not an object as invalid', () => {
    expect(parseStreamLine('5')).toEqual({ type: 'invalid', line: '5' });
    expect(parseStreamLine('"text"')).toEqual({ type: 'invalid', line: '"text"' });
    expect(parseStreamLine('null')).toEqual({ type: 'invalid', line: 'null' });
  });

  it('reads an init message with only the fields the CLI sent', () => {
    const raw = { type: 'system', subtype: 'init', session_id: 's1', cwd: '/work', tools: ['Bash', 3, 'Read'], model: 'opus' };
    expect(parseStreamLine(line(raw))).toStrictEqual({
      type: 'system',
      subtype: 'init',
      sessionId: 's1',
      model: 'opus',
      cwd: '/work',
      tools: ['Bash', 'Read'],
      raw,
    });

    const bare = { type: 'system', subtype: 'init', session_id: 's1' };
    expect(parseStreamLine(line(bare))).toStrictEqual({ type: 'system', subtype: 'init', sessionId: 's1', raw: bare });
  });

  it('keeps other system messages, like API retries, with their subtype', () => {
    const retry = {
      type: 'system',
      subtype: 'api_retry',
      attempt: 1,
      max_retries: 10,
      retry_delay_ms: 554,
      error_status: 429,
      error: 'rate_limit',
      session_id: 's1',
    };
    expect(parseStreamLine(line(retry))).toStrictEqual({ type: 'system', subtype: 'api_retry', sessionId: 's1', raw: retry });

    const noSubtype = { type: 'system' };
    expect(parseStreamLine(line(noSubtype))).toStrictEqual({ type: 'system', subtype: '', raw: noSubtype });
  });

  it('reads an assistant message without a message body as empty', () => {
    const raw = { type: 'assistant', session_id: 's1' };
    expect(parseStreamLine(line(raw))).toStrictEqual({ type: 'assistant', sessionId: 's1', content: [], raw });
  });

  it('marks messages a subagent produced with the parent tool call', () => {
    const raw = {
      type: 'assistant',
      parent_tool_use_id: 'toolu_task',
      message: { id: 'msg_1', model: 'claude-haiku-4-5', content: [{ type: 'text', text: 'done' }] },
    };
    expect(parseStreamLine(line(raw))).toStrictEqual({
      type: 'assistant',
      parentToolUseId: 'toolu_task',
      messageId: 'msg_1',
      model: 'claude-haiku-4-5',
      content: [{ type: 'text', text: 'done' }],
      raw,
    });
  });

  it('copies only the usage counts that are finite numbers', () => {
    const parsed = parseStreamLine(
      '{"type":"assistant","message":{"content":[],"usage":{"input_tokens":7,"output_tokens":"3","cache_read_input_tokens":1e400,"cache_creation":{"ephemeral_1h_input_tokens":5}}}}',
    );
    expect((parsed as { usage?: unknown }).usage).toStrictEqual({ input_tokens: 7, cache_creation: { ephemeral_1h_input_tokens: 5 } });

    const fiveMinutes = parseStreamLine(line({ type: 'assistant', message: { content: [], usage: { cache_creation: { ephemeral_5m_input_tokens: 9 } } } }));
    expect((fiveMinutes as { usage?: unknown }).usage).toStrictEqual({ cache_creation: { ephemeral_5m_input_tokens: 9 } });
  });

  it('reads every content block kind and fills in missing fields', () => {
    const image = { type: 'image', source: { type: 'base64', data: 'AAAA' } };
    const raw = {
      type: 'assistant',
      message: {
        content: [
          null,
          'loose text',
          ['nested'],
          { type: 'text' },
          { type: 'thinking' },
          { type: 'tool_use', id: ['x'], name: '' },
          { type: 'tool_use', id: 'toolu_1', name: ['Bash'], input: { command: 'ls' } },
          { type: 'tool_result' },
          image,
        ],
      },
    };
    expect((parseStreamLine(line(raw)) as { content: unknown }).content).toStrictEqual([
      { type: 'text', text: '' },
      { type: 'thinking', thinking: '' },
      { type: 'tool_use', id: '', name: 'unknown', input: {} },
      { type: 'tool_use', id: 'toolu_1', name: 'unknown', input: { command: 'ls' } },
      { type: 'tool_result', toolUseId: '', content: '', isError: false },
      { type: 'unknown', raw: image },
    ]);
  });

  it('joins the text parts of a tool result and drops the rest', () => {
    const raw = {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_1',
            is_error: true,
            content: [{ type: 'text', text: 'first' }, { type: 'image' }, 'loose', { type: 'text', text: '' }, { type: 'text', text: 'second' }],
          },
          { type: 'tool_result', tool_use_id: 'toolu_2', content: { text: 'not a list' } },
        ],
      },
    };
    expect((parseStreamLine(line(raw)) as { content: unknown }).content).toStrictEqual([
      { type: 'tool_result', toolUseId: 'toolu_1', content: 'first\nsecond', isError: true },
      { type: 'tool_result', toolUseId: 'toolu_2', content: '', isError: false },
    ]);
  });

  it('reads a user turn echoed back as plain text', () => {
    expect(parseStreamLine(line({ type: 'user', message: { content: 'Fix the bug' } }))).toMatchObject({
      content: [{ type: 'text', text: 'Fix the bug' }],
    });
    expect(parseStreamLine(line({ type: 'user', message: { content: '' } }))).toMatchObject({ content: [] });
    expect(parseStreamLine(line({ type: 'user', message: { content: 42 } }))).toMatchObject({ content: [] });
    expect(parseStreamLine(line({ type: 'user' }))).toMatchObject({ content: [] });
  });

  it('reads a minimal result without inventing fields', () => {
    const raw = { type: 'result', result: 42 };
    expect(parseStreamLine(line(raw))).toStrictEqual({ type: 'result', subtype: '', isError: false, errors: [], raw });
  });

  it('reads the numbers of an error result', () => {
    const raw = {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      result: '',
      duration_ms: 412,
      num_turns: 2,
      total_cost_usd: 0,
      api_error_status: 429,
      session_id: 's1',
    };
    expect(parseStreamLine(line(raw))).toStrictEqual({
      type: 'result',
      subtype: 'error_during_execution',
      isError: true,
      sessionId: 's1',
      errors: [],
      result: '',
      durationMs: 412,
      numTurns: 2,
      totalCostUsd: 0,
      apiErrorStatus: 429,
      raw,
    });
    expect(parseStreamLine(line({ type: 'result', duration_ms: '412' }))).not.toHaveProperty('durationMs');
  });

  it('turns each kind of result error into a message', () => {
    const raw = {
      type: 'result',
      errors: ['  boom  ', '   ', 7, null, { message: 'from message' }, { error: 'from error' }, { code: 'E_CODE' }, { detail: 'x' }],
    };
    expect((parseStreamLine(line(raw)) as { errors: unknown }).errors).toEqual([
      'boom',
      'from message',
      'from error',
      'E_CODE',
      '{"detail":"x"}',
    ]);
  });

  it('reads when a rate limit resets from seconds, milliseconds or an ISO date', () => {
    const resetsAt = (value: unknown) =>
      (parseStreamLine(line({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: value } })) as { resetsAt?: Date })
        .resetsAt;

    expect(resetsAt(1793290933)).toEqual(new Date(1793290933 * 1000));
    expect(resetsAt(1793290933000)).toEqual(new Date(1793290933000));
    expect(resetsAt(1e12)).toEqual(new Date(1e12));
    expect(resetsAt('2026-10-29T15:00:00.000Z')).toEqual(new Date('2026-10-29T15:00:00.000Z'));
    expect(resetsAt('soon')).toBeUndefined();
    expect(resetsAt('')).toBeUndefined();
    expect(resetsAt(0)).toBeUndefined();
    expect(resetsAt(-5)).toBeUndefined();
    expect(
      (parseStreamLine('{"type":"rate_limit_event","rate_limit_info":{"resetsAt":1e400}}') as { resetsAt?: Date }).resetsAt,
    ).toBeUndefined();
  });

  it('reads a CLI 2.1.312 rate-limit event', () => {
    const raw = {
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', resetsAt: 1793290933, rateLimitType: 'five_hour', isUsingOverage: false },
      session_id: 's1',
    };
    expect(parseStreamLine(line(raw))).toStrictEqual({
      type: 'rate_limit',
      sessionId: 's1',
      status: 'rejected',
      resetsAt: new Date(1793290933 * 1000),
      rateLimitType: 'five_hour',
      raw,
    });
  });
});

describe('createLineSplitter edge cases', () => {
  it('skips blank lines and strips the carriage return of the last line once', () => {
    const lines: string[] = [];
    const splitter = createLineSplitter(line => lines.push(line));
    splitter.push('  \n{"a":1}\n \t\n{"b":2}\r');
    splitter.flush();
    splitter.flush();
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);

    splitter.push('   ');
    splitter.flush();
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });
});
