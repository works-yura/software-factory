/**
 * Why a Claude Code turn failed, in terms a scheduler or credential pool can
 * act on: a rate limit carries when to retry; an auth failure must not be
 * retried blindly; an unknown session means the resume id is stale.
 */

export type ClaudeCodeErrorKind =
  | 'rate_limit'
  | 'overloaded'
  | 'auth'
  | 'unknown_session'
  | 'max_turns'
  | 'timeout'
  | 'process'
  | 'failed';

export class ClaudeCodeError extends Error {
  readonly kind: ClaudeCodeErrorKind;
  /** HTTP status the CLI reported, when it did. */
  readonly status?: number;
  /** When a usage or rate limit resets, if the CLI said. */
  readonly resetsAt?: Date;
  /** Milliseconds until `resetsAt` at classification time. */
  readonly retryAfter?: number;

  constructor(
    kind: ClaudeCodeErrorKind,
    message: string,
    details: { status?: number; resetsAt?: Date; now?: Date } = {},
  ) {
    super(message);
    this.name = 'ClaudeCodeError';
    this.kind = kind;
    if (details.status !== undefined) this.status = details.status;
    if (details.resetsAt) {
      this.resetsAt = details.resetsAt;
      this.retryAfter = Math.max(0, details.resetsAt.getTime() - (details.now ?? new Date()).getTime());
    }
  }

  get retryable(): boolean {
    return this.kind === 'rate_limit' || this.kind === 'overloaded' || this.kind === 'timeout';
  }
}

const AUTH_RE =
  /(?:not\s+logged\s+in|please\s+log\s+in|please\s+run\s+`?\/?(?:claude\s+)?login`?|login\s+required|invalid\s+api\s+key|unauthorized|authentication(?:_failed|\s+failed|\s+required|_error)|oauth\s+token\s+(?:has\s+)?expired|\b401\b)/i;
const UNKNOWN_SESSION_RE =
  /no conversation found with session id|unknown session|session .* not found|--resume requires a valid session/i;
const USAGE_LIMIT_RE =
  /(?:out\s+of\s+extra\s+usage|claude(?:\s+ai)?\s+usage\s+limit\s+reached|5[-\s]?hour\s+limit\s+reached|weekly\s+limit\s+reached|usage\s+limit\s+reached|usage\s+cap\s+reached|session\s+limit\s+reached)/i;
const RATE_LIMIT_RE = /(?:rate[-\s]?limit(?:ed)?|rate_limit_error|too\s+many\s+requests|\b429\b)/i;
const OVERLOADED_RE = /(?:overloaded(?:_error)?|\b529\b|\b503\b|service\s+unavailable|temporarily\s+unavailable)/i;
/** Older CLIs print `Claude AI usage limit reached|<unix seconds>`. */
const RESET_EPOCH_RE = /usage\s+limit\s+reached\|(\d{9,13})/i;
const RESET_CLOCK_RE = /\bresets?\s+(?:at\s+)?(\d{1,2}(?::\d{2})?\s*[ap]\.?\s*m\.?)(?:\s*\(([^)]+)\))?/i;

function zonedParts(date: Date, timeZone: string) {
  const parts = new Map(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
      .formatToParts(date)
      .map(part => [part.type, Number.parseInt(part.value, 10)]),
  );
  return {
    year: parts.get('year') ?? 0,
    month: parts.get('month') ?? 1,
    day: parts.get('day') ?? 1,
    hour: parts.get('hour') ?? 0,
    minute: parts.get('minute') ?? 0,
  };
}

/** The next wall-clock `hour:minute` in a time zone (or the local zone), strictly after `now`. */
function nextWallClock(now: Date, hour: number, minute: number, timeZone?: string): Date {
  let zone: string | undefined;
  if (timeZone) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone }).format(now);
      zone = timeZone;
    } catch {
      zone = undefined;
    }
  }
  if (!zone) {
    const local = new Date(now);
    local.setHours(hour, minute, 0, 0);
    if (local.getTime() <= now.getTime()) local.setDate(local.getDate() + 1);
    return local;
  }
  const today = zonedParts(now, zone);
  for (const dayOffset of [0, 1]) {
    const target = Date.UTC(today.year, today.month - 1, today.day + dayOffset, hour, minute);
    // Correct the zone offset (twice covers a DST edge).
    let candidate = new Date(target);
    for (let i = 0; i < 2; i += 1) {
      const actual = zonedParts(candidate, zone);
      const actualUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute);
      candidate = new Date(candidate.getTime() + (target - actualUtc));
    }
    if (candidate.getTime() > now.getTime()) return candidate;
  }
  return new Date(now.getTime() + 24 * 3_600_000);
}

/** When a usage limit resets, from the CLI's own wording. */
export function parseResetTime(text: string, now = new Date()): Date | undefined {
  const epoch = text.match(RESET_EPOCH_RE);
  if (epoch?.[1]) {
    const value = Number.parseInt(epoch[1], 10);
    return new Date(value < 1e12 ? value * 1000 : value);
  }
  const clock = text.match(RESET_CLOCK_RE);
  if (!clock?.[1]) return undefined;
  const parsed = clock[1].replace(/\s+/g, '').match(/^(\d{1,2})(?::(\d{2}))?([ap])/i);
  if (!parsed) return undefined;
  const hour12 = Number.parseInt(parsed[1] ?? '', 10);
  const minute = Number.parseInt(parsed[2] ?? '0', 10);
  if (hour12 < 1 || hour12 > 12 || minute > 59) return undefined;
  const hour = (hour12 % 12) + ((parsed[3] ?? '').toLowerCase() === 'p' ? 12 : 0);
  return nextWallClock(now, hour, minute, clock[2]?.trim());
}

export interface FailureEvidence {
  /** `result.result` text or a synthetic API-error assistant message. */
  text?: string;
  errors?: readonly string[];
  stderr?: string;
  /** `result.subtype`. */
  subtype?: string;
  status?: number;
  /** The assistant message's `error` marker (`rate_limit`, `authentication_failed`, …). */
  errorMarker?: string;
  /** A rejected `rate_limit_event` seen in the stream. */
  rateLimitResetsAt?: Date;
  exitCode?: number | null;
}

/** Classifies a failed turn. Deterministic failures win over the transient patterns they may also mention. */
export function classifyFailure(evidence: FailureEvidence, now = new Date()): ClaudeCodeError {
  const haystack = [evidence.text ?? '', ...(evidence.errors ?? []), evidence.stderr ?? '']
    .join('\n')
    .trim();
  const message =
    [evidence.text, ...(evidence.errors ?? [])].map(part => part?.trim()).find(Boolean) ??
    evidence.stderr?.trim().split('\n').slice(-5).join('\n') ??
    '';
  const describe = (fallback: string) => message || fallback;
  const status = evidence.status;
  const details = { ...(status !== undefined ? { status } : {}), now };

  if (evidence.subtype === 'error_max_turns') {
    return new ClaudeCodeError('max_turns', describe('Claude Code hit its turn limit.'), details);
  }
  if (UNKNOWN_SESSION_RE.test(haystack)) {
    return new ClaudeCodeError('unknown_session', describe('Claude Code could not resume the session.'), details);
  }
  if (evidence.errorMarker === 'authentication_failed' || status === 401 || status === 403 || AUTH_RE.test(haystack)) {
    return new ClaudeCodeError('auth', describe('Claude Code authentication failed.'), details);
  }
  // The stream's own reset time is exact; the wording is wall-clock and zone-guessed.
  const resetsAt = evidence.rateLimitResetsAt ?? parseResetTime(haystack, now);
  if (
    evidence.errorMarker === 'rate_limit' ||
    status === 429 ||
    evidence.rateLimitResetsAt !== undefined ||
    USAGE_LIMIT_RE.test(haystack) ||
    RATE_LIMIT_RE.test(haystack)
  ) {
    return new ClaudeCodeError('rate_limit', describe('Claude Code hit a rate limit.'), {
      ...details,
      ...(resetsAt ? { resetsAt } : {}),
    });
  }
  if (status === 529 || status === 503 || evidence.errorMarker === 'server_error' || OVERLOADED_RE.test(haystack)) {
    return new ClaudeCodeError('overloaded', describe('Claude is overloaded.'), details);
  }
  if (!message && evidence.exitCode !== undefined) {
    return new ClaudeCodeError('process', `Claude Code exited with code ${String(evidence.exitCode)}.`, details);
  }
  return new ClaudeCodeError('failed', describe('Claude Code turn failed.'), details);
}
