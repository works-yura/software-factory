/**
 * A run that ended because every model account it may use is out of usage is not a
 * failure to retry at once: it waits for the limit to reset, then resumes.
 *
 * How each harness says so:
 * - Claude Code and Codex end the run with an error whose `kind` is `rate_limit`
 *   (`ClaudeCodeError`, `CodexError`); the account pool's "every account is out of usage"
 *   error and a provider's own limit both carry `resetsAt` when it is known.
 * - Mastra ends the run with the provider's error (an AI SDK `APICallError`, possibly
 *   wrapped): HTTP 429, or a usage-cap wording such as Claude Max's 400 "usage limit
 *   reached". The reset comes from `Retry-After` (or Anthropic's unified reset header)
 *   when the provider sent one.
 */

/** How long a card keeps waiting on usage limits before it fails with `run_usage_limited`. */
export const USAGE_LIMIT_MAX_WAIT_MS = 7 * 24 * 60 * 60_000;
/** The first wait when nobody said when the limit resets; it doubles with each wait. */
const UNKNOWN_RESET_FIRST_WAIT_MS = 5 * 60_000;
/** The longest wait when nobody said when the limit resets: the account pool's own cooldown. */
const UNKNOWN_RESET_MAX_WAIT_MS = 60 * 60_000;
/** Resuming a little after the reset spreads the cards that waited on it, and covers clock skew. */
const RESUME_JITTER_MIN_MS = 60_000;
const RESUME_JITTER_MAX_MS = 3 * 60_000;
const MAX_DEPTH = 4;

export interface UsageLimit {
  /** When the limit resets, when the harness or provider said. */
  resetsAt?: Date;
}

// Billing that ran dry does not reset on its own; a person has to fix it.
const BILLING_EXHAUSTED =
  /insufficient[_ ]quota|insufficient (?:balance|credits?)|credits? exhausted|credit balance|payment required/i;
const USAGE_LIMIT_WORDING =
  /out of (?:extra )?usage|usage (?:limit|cap)|quota (?:exceeded|exhausted|reached)|exceeded (?:your )?current quota|(?:weekly|monthly|5[- ]?hour|session) limit reached|rate[ _-]?limit(?:ed| exceeded| reached|_error)|too many requests/i;
const ISO_INSTANT = /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}))/;

function field(value: object, key: string): unknown {
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function dateOf(value: unknown): Date | undefined {
  const date =
    value instanceof Date
      ? value
      : typeof value === 'string' && value.trim()
        ? new Date(value)
        : typeof value === 'number' && Number.isFinite(value)
          ? new Date(value < 1e12 ? value * 1000 : value)
          : undefined;
  return date && !Number.isNaN(date.getTime()) ? date : undefined;
}

function header(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== 'object') return undefined;
  if (typeof (headers as { get?: unknown }).get === 'function') {
    const value = (headers as { get(name: string): unknown }).get(name);
    return typeof value === 'string' ? value : undefined;
  }
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (key.toLowerCase() === name && typeof value === 'string') return value;
  }
  return undefined;
}

/** When the provider's response headers say the limit resets. */
function resetFromHeaders(headers: unknown, now: Date): Date | undefined {
  const retryAfterMs = Number(header(headers, 'retry-after-ms'));
  if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) return new Date(now.getTime() + retryAfterMs);
  const retryAfter = header(headers, 'retry-after')?.trim();
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return new Date(now.getTime() + Math.max(0, seconds) * 1000);
    const at = dateOf(retryAfter);
    if (at) return at;
  }
  // Anthropic's subscription limits name the reset as epoch seconds.
  const unified = Number(header(headers, 'anthropic-ratelimit-unified-reset'));
  return Number.isFinite(unified) && unified > 0 ? new Date(unified * 1000) : undefined;
}

function texts(value: object): string[] {
  return ['message', 'responseBody', 'reason', 'detail']
    .map(key => field(value, key))
    .filter((text): text is string => typeof text === 'string');
}

/** The usage limit an error reports, or `undefined` for any other failure. */
export function usageLimitOf(error: unknown, now: Date = new Date()): UsageLimit | undefined {
  let limited = false;
  let billing = false;
  let resetsAt: Date | undefined;
  const seen = new Set<object>();
  const visit = (value: unknown, depth: number) => {
    if (depth > MAX_DEPTH || value === null || value === undefined) return;
    if (typeof value === 'string') {
      if (BILLING_EXHAUSTED.test(value)) billing = true;
      else if (USAGE_LIMIT_WORDING.test(value)) limited = true;
      return;
    }
    if (typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    // Claude Code and Codex name the failure themselves.
    if (field(value, 'kind') === 'rate_limit') limited = true;
    const status = field(value, 'statusCode') ?? field(value, 'status');
    if (status === 429) limited = true;
    resetsAt ??= dateOf(field(value, 'resetsAt'));
    const retryAfter = field(value, 'retryAfter');
    if (!resetsAt && typeof retryAfter === 'number' && retryAfter >= 0) {
      resetsAt = new Date(now.getTime() + retryAfter);
    }
    resetsAt ??= resetFromHeaders(field(value, 'responseHeaders'), now);
    for (const text of texts(value)) visit(text, depth);
    for (const key of ['cause', 'error', 'lastError', 'data']) visit(field(value, key), depth + 1);
    const errors = field(value, 'errors');
    if (Array.isArray(errors)) visit(errors.at(-1), depth + 1);
  };
  visit(error, 0);
  if (!limited || billing) return undefined;
  if (!resetsAt && error && typeof error === 'object') {
    // The account pool says when the first account comes back only in its message.
    const message = texts(error).join(' ').match(ISO_INSTANT)?.[1];
    resetsAt = dateOf(message);
  } else if (!resetsAt && typeof error === 'string') {
    resetsAt = dateOf(error.match(ISO_INSTANT)?.[1]);
  }
  return resetsAt ? { resetsAt } : {};
}

/**
 * When a run that hit `limit` resumes: shortly after the reset, or — when nobody said
 * when that is — after a wait that grows with each one, up to the account pool's cooldown.
 */
export function usageLimitResumeAt(
  limit: UsageLimit,
  { now, waits, random = Math.random }: { now: Date; waits: number; random?: () => number },
): Date {
  const jitter = RESUME_JITTER_MIN_MS + Math.floor(random() * (RESUME_JITTER_MAX_MS - RESUME_JITTER_MIN_MS));
  if (limit.resetsAt) return new Date(Math.max(limit.resetsAt.getTime(), now.getTime()) + jitter);
  const wait = Math.min(UNKNOWN_RESET_FIRST_WAIT_MS * 2 ** Math.max(0, waits), UNKNOWN_RESET_MAX_WAIT_MS);
  return new Date(now.getTime() + wait + jitter);
}

/** Whether waiting until `resumeAt` stays within {@link USAGE_LIMIT_MAX_WAIT_MS} of the first limit. */
export function usageLimitWaitAllowed(limitedSince: Date | null, resumeAt: Date, now: Date): boolean {
  return resumeAt.getTime() - (limitedSince ?? now).getTime() <= USAGE_LIMIT_MAX_WAIT_MS;
}
