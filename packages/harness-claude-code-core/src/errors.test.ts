import { describe, expect, it } from 'vitest';

import { ClaudeCodeError, classifyFailure, parseResetTime } from './errors.ts';

const NOW = new Date('2026-10-29T10:00:00Z');

describe('classifyFailure', () => {
  const kind = (evidence: Parameters<typeof classifyFailure>[0]) => classifyFailure(evidence, NOW).kind;

  it('reads the turn limit from the result subtype, before anything the text says', () => {
    expect(kind({ subtype: 'error_max_turns', text: 'rate limit 401' })).toBe('max_turns');
  });

  it.each([
    'No conversation found with session ID: 9f0c',
    'unknown session',
    'Session abc not found',
    '--resume requires a valid session',
  ])('knows a lost session: %s', text => {
    expect(kind({ text })).toBe('unknown_session');
  });

  it.each([
    ['marker', { errorMarker: 'authentication_failed' }],
    ['401', { status: 401 }],
    ['403', { status: 403 }],
    ['wording', { text: 'Invalid API key · Please run /login' }],
    ['not logged in', { text: 'Not logged in' }],
    ['expired token', { text: 'OAuth token has expired' }],
    ['stderr', { stderr: 'Error: authentication_error' }],
  ] as const)('knows a refused account (%s)', (_, evidence) => {
    expect(kind(evidence)).toBe('auth');
  });

  it.each([
    ['marker', { errorMarker: 'rate_limit' }],
    ['429', { status: 429 }],
    ['stream reset', { rateLimitResetsAt: new Date('2026-10-29T13:00:00Z') }],
    ['usage wording', { text: "Claude AI usage limit reached|1793318400" }],
    ['5-hour wording', { text: '5-hour limit reached ∙ resets 3pm' }],
    ['weekly wording', { text: 'Weekly limit reached' }],
    ['rate wording', { errors: ['rate_limit_error: too many requests'] }],
  ] as const)('knows a rate limit (%s)', (_, evidence) => {
    expect(kind(evidence)).toBe('rate_limit');
  });

  it.each([
    ['529', { status: 529 }],
    ['503', { status: 503 }],
    ['marker', { errorMarker: 'server_error' }],
    ['wording', { text: 'API Error: overloaded_error' }],
  ] as const)('knows an overloaded API (%s)', (_, evidence) => {
    expect(kind(evidence)).toBe('overloaded');
  });

  it('blames the process when it died without a word', () => {
    const error = classifyFailure({ exitCode: 137 }, NOW);
    expect(error).toMatchObject({ kind: 'process', message: 'Claude Code exited with code 137.' });
  });

  it('names the signal that killed a silent process, instead of a null exit code', () => {
    const error = classifyFailure({ exitCode: null, signal: 'SIGKILL' }, NOW);
    expect(error).toMatchObject({ kind: 'process', message: 'Claude Code was killed by SIGKILL.' });
  });

  it.each([
    [{ subtype: 'error_max_turns' }, 'Claude Code hit its turn limit.'],
    [{ errors: [], stderr: '', status: 401 }, 'Claude Code authentication failed.'],
    [{ status: 429 }, 'Claude Code hit a rate limit.'],
    [{ status: 529 }, 'Claude is overloaded.'],
  ] as const)('says what happened when the CLI said nothing: %j', (evidence, message) => {
    expect(classifyFailure(evidence, NOW).message).toBe(message);
  });

  it('says a session was lost in its own words when the CLI gave none', () => {
    // Only the wording finds a lost session; a bare stderr line is the message.
    expect(classifyFailure({ stderr: 'unknown session' }, NOW)).toMatchObject({ kind: 'unknown_session', message: 'unknown session' });
  });

  it('searches the errors and stderr too, not just the result text', () => {
    expect(classifyFailure({ text: 'Turn failed.', errors: ['429 Too Many Requests'] }, NOW).kind).toBe('rate_limit');
    expect(classifyFailure({ text: 'Turn failed.', stderr: 'Error: 529 overloaded' }, NOW).kind).toBe('overloaded');
  });

  it('keeps the CLI’s own words as the message, the text first', () => {
    expect(classifyFailure({ text: ' Something odd ', errors: ['second'], exitCode: 1 }, NOW).message).toBe('Something odd');
    expect(classifyFailure({ errors: ['', ' from errors '] }, NOW).message).toBe('from errors');
    expect(classifyFailure({ stderr: 'a\nb\nc\nd\ne\nf\ng' }, NOW).message).toBe('c\nd\ne\nf\ng');
    expect(classifyFailure({}, NOW)).toMatchObject({ kind: 'failed', message: 'Claude Code turn failed.' });
  });

  it('prefers the stream’s exact reset time over the wording, and says how long to wait', () => {
    const exact = new Date('2026-10-29T13:00:00Z');
    const error = classifyFailure({ text: 'usage limit reached|1793318400', rateLimitResetsAt: exact }, NOW);
    expect(error.resetsAt).toEqual(exact);
    expect(error.retryAfter).toBe(3 * 3_600_000);
    expect(error.retryable).toBe(true);
  });

  it('carries the HTTP status', () => {
    expect(classifyFailure({ status: 429 }, NOW).status).toBe(429);
    expect(classifyFailure({ text: 'x' }, NOW).status).toBeUndefined();
  });
});

describe('ClaudeCodeError', () => {
  it.each([
    ['rate_limit', true],
    ['overloaded', true],
    ['timeout', true],
    ['auth', false],
    ['failed', false],
    ['process', false],
  ] as const)('%s is retryable: %s', (kind, retryable) => {
    expect(new ClaudeCodeError(kind, 'x').retryable).toBe(retryable);
  });

  it('never waits a negative time for a reset in the past', () => {
    const error = new ClaudeCodeError('rate_limit', 'x', { resetsAt: new Date(NOW.getTime() - 1000), now: NOW });
    expect(error.retryAfter).toBe(0);
    expect(error.name).toBe('ClaudeCodeError');
  });
});

describe('parseResetTime', () => {
  it('reads the epoch the CLI appends, in seconds or milliseconds', () => {
    expect(parseResetTime('Claude AI usage limit reached|1793318400', NOW)).toEqual(new Date(1793318400 * 1000));
    expect(parseResetTime('usage limit reached|1793318400000', NOW)).toEqual(new Date(1793318400000));
  });

  it('reads a wall-clock reset in the zone the CLI names, today when it is still ahead', () => {
    // Kyiv is on winter time (UTC+2) by 29 October: 3pm there is 13:00 UTC.
    expect(parseResetTime('5-hour limit reached ∙ resets 3pm (Europe/Kyiv)', NOW)).toEqual(new Date('2026-10-29T13:00:00Z'));
    expect(parseResetTime('resets at 3:30 p.m. (Europe/Kyiv)', NOW)).toEqual(new Date('2026-10-29T13:30:00Z'));
    // Summer time (UTC+3) in July.
    expect(parseResetTime('resets 3pm (Europe/Kyiv)', new Date('2026-07-01T10:00:00Z'))).toEqual(new Date('2026-07-01T12:00:00Z'));
  });

  it('rolls a wall-clock time already past over to tomorrow', () => {
    expect(parseResetTime('resets 9am (UTC)', NOW)).toEqual(new Date('2026-10-30T09:00:00Z'));
    expect(parseResetTime('resets 12am (UTC)', NOW)).toEqual(new Date('2026-10-30T00:00:00Z'));
    expect(parseResetTime('resets 12pm (UTC)', NOW)).toEqual(new Date('2026-10-29T12:00:00Z'));
  });

  it('reads an epoch in seconds right up to the millisecond range', () => {
    expect(parseResetTime('usage limit reached|999999999999', NOW)).toEqual(new Date(999999999999 * 1000));
    expect(parseResetTime('usage limit reached|1000000000000', NOW)).toEqual(new Date(1000000000000));
  });

  it('reads the time with the zone trimmed, and a minute of 59', () => {
    expect(parseResetTime('resets 11:59pm ( UTC )', NOW)).toEqual(new Date('2026-10-29T23:59:00Z'));
    expect(parseResetTime('resets 1am (UTC)', NOW)).toEqual(new Date('2026-10-30T01:00:00Z'));
  });

  it('rolls over to tomorrow at exactly the current time, in a known zone and in the server’s own', () => {
    expect(parseResetTime('resets 10am (UTC)', NOW)).toEqual(new Date('2026-10-30T10:00:00Z'));
    const now = new Date(2026, 9, 29, 15, 0, 0, 0);
    expect(parseResetTime('resets 3pm', now)).toEqual(new Date(2026, 9, 30, 15, 0, 0, 0));
    expect(parseResetTime('resets 4pm', now)).toEqual(new Date(2026, 9, 29, 16, 0, 0, 0));
  });

  it('falls back to the server’s own zone for a zone it does not know', () => {
    const local = parseResetTime('resets 11pm (Mars/Olympus)', NOW)!;
    expect(local.getHours()).toBe(23);
    expect(local.getMinutes()).toBe(0);
    expect(local.getTime()).toBeGreaterThan(NOW.getTime());
  });

  it('finds nothing in text without a reset, or with an impossible time', () => {
    expect(parseResetTime('rate limited', NOW)).toBeUndefined();
    expect(parseResetTime('resets 13pm (UTC)', NOW)).toBeUndefined();
    expect(parseResetTime('resets 0am (UTC)', NOW)).toBeUndefined();
    expect(parseResetTime('resets 3:75pm (UTC)', NOW)).toBeUndefined();
  });
});
