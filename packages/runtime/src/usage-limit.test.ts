import { describe, expect, it } from 'vitest';

import { USAGE_LIMIT_MAX_WAIT_MS, usageLimitOf, usageLimitResumeAt, usageLimitWaitAllowed } from './usage-limit.ts';

const NOW = new Date('2030-01-01T12:00:00.000Z');
const RESET = new Date('2030-01-01T17:00:00.000Z');

describe('usageLimitOf', () => {
  it('reads the account pool’s limit on a Claude Code run (`ClaudeCodeError`)', () => {
    const error = Object.assign(
      new Error(`Every Claude account this run may use is out of usage; the first comes back at ${RESET.toISOString()}.`),
      { name: 'ClaudeCodeError', kind: 'rate_limit', resetsAt: RESET, retryAfter: RESET.getTime() - NOW.getTime() },
    );
    expect(usageLimitOf(error, NOW)).toEqual({ resetsAt: RESET });
  });

  it('reads a Codex limit (`CodexError`) whose reset came from the account’s limits', () => {
    const error = Object.assign(new Error('You have hit your usage limit.'), {
      name: 'CodexError',
      kind: 'rate_limit',
      code: 'usageLimitExceeded',
      resetsAt: RESET,
    });
    expect(usageLimitOf(error, NOW)).toEqual({ resetsAt: RESET });
  });

  it('reads the reset from the message when the error was serialized without it', () => {
    expect(
      usageLimitOf(
        { kind: 'rate_limit', message: `Every ChatGPT account this run may use is out of usage; the first comes back at ${RESET.toISOString()}.` },
        NOW,
      ),
    ).toEqual({ resetsAt: RESET });
  });

  it('reads a Mastra provider 429 with Retry-After, through the error that wraps it', () => {
    const providerError = Object.assign(new Error('Too Many Requests'), {
      name: 'AI_APICallError',
      statusCode: 429,
      responseHeaders: { 'Retry-After': '120' },
    });
    const wrapped = Object.assign(new Error('Stream failed'), { cause: providerError });
    expect(usageLimitOf(wrapped, NOW)).toEqual({ resetsAt: new Date(NOW.getTime() + 120_000) });
  });

  it('reads Anthropic’s unified reset header, and a 400 that says the usage limit was reached', () => {
    const error = Object.assign(new Error('Claude AI usage limit reached'), {
      name: 'AI_APICallError',
      statusCode: 400,
      responseHeaders: { 'anthropic-ratelimit-unified-reset': String(RESET.getTime() / 1000) },
    });
    expect(usageLimitOf(error, NOW)).toEqual({ resetsAt: RESET });
  });

  it('knows a limit without a reset time', () => {
    expect(usageLimitOf(Object.assign(new Error('Rate limited'), { statusCode: 429 }), NOW)).toEqual({});
  });

  it.each([
    ['a provider 401', Object.assign(new Error('Unauthorized'), { statusCode: 401 })],
    ['an exhausted credit balance', Object.assign(new Error('Your credit balance is too low'), { statusCode: 429 })],
    ['an OpenAI insufficient_quota', Object.assign(new Error('insufficient_quota'), { statusCode: 429 })],
    ['a broken stream', new Error('Provider stream closed unexpectedly (ECONNRESET)')],
    ['an auth failure', Object.assign(new Error('Not logged in'), { kind: 'auth' })],
    ['nothing', undefined],
  ])('is not a usage limit: %s', (_label, error) => {
    expect(usageLimitOf(error, NOW)).toBeUndefined();
  });
});

describe('usageLimitResumeAt', () => {
  it('resumes one to three minutes after the reset', () => {
    expect(usageLimitResumeAt({ resetsAt: RESET }, { now: NOW, waits: 0, random: () => 0 })).toEqual(
      new Date(RESET.getTime() + 60_000),
    );
    expect(
      usageLimitResumeAt({ resetsAt: RESET }, { now: NOW, waits: 0, random: () => 0.999999 }).getTime(),
    ).toBeLessThanOrEqual(RESET.getTime() + 3 * 60_000);
  });

  it('resumes soon when the reset already passed', () => {
    expect(usageLimitResumeAt({ resetsAt: new Date(0) }, { now: NOW, waits: 0, random: () => 0 })).toEqual(
      new Date(NOW.getTime() + 60_000),
    );
  });

  it('waits longer each time nobody said when the limit resets, up to an hour', () => {
    const wait = (waits: number) =>
      usageLimitResumeAt({}, { now: NOW, waits, random: () => 0 }).getTime() - NOW.getTime() - 60_000;
    expect([wait(0), wait(1), wait(2), wait(3), wait(4), wait(10)]).toEqual(
      [5, 10, 20, 40, 60, 60].map(minutes => minutes * 60_000),
    );
  });
});

describe('usageLimitWaitAllowed', () => {
  it('stops waiting a week after the first limit', () => {
    const since = new Date(NOW.getTime() - USAGE_LIMIT_MAX_WAIT_MS + 60_000);
    expect(usageLimitWaitAllowed(since, new Date(NOW.getTime() + 30_000), NOW)).toBe(true);
    expect(usageLimitWaitAllowed(since, new Date(NOW.getTime() + 2 * 60_000), NOW)).toBe(false);
    expect(usageLimitWaitAllowed(null, new Date(NOW.getTime() + USAGE_LIMIT_MAX_WAIT_MS + 1), NOW)).toBe(false);
  });
});
