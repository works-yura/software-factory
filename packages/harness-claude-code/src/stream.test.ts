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
