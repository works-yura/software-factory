import { describe, expect, it } from 'vitest';

import { fixture } from './__fixtures__/fake-claude.ts';
import { classifyFailure, ClaudeCodeError, parseResetTime } from './errors.ts';
import { toTokenUsage, TurnTranslator, type ClaudeTranscriptEntry } from './events.ts';
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
