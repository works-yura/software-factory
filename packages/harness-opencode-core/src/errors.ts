// Why an OpenCode turn failed, in the kinds a Claude Code or Codex turn's failure has (`auth`,
// `rate_limit`, …), so the chat and the run reports read all of them the same way. OpenCode's own
// errors (`session.error`, an assistant message's `error`, a `retry` status) are classified here.

export type OpenCodeErrorKind =
  | 'auth'
  | 'rate_limit'
  | 'overloaded'
  | 'context'
  | 'model_unavailable'
  | 'process'
  | 'timeout'
  | 'unknown_session'
  | 'unknown';

export class OpenCodeError extends Error {
  readonly _tag = 'OpenCodeError';
  readonly kind: OpenCodeErrorKind;
  /** HTTP status OpenCode reported, when it did. */
  readonly status?: number;
  /** OpenCode's own error name (`ProviderAuthError`, `APIError`, …), when it named one. */
  readonly code?: string;

  constructor(kind: OpenCodeErrorKind, message: string, details: { status?: number; code?: string; cause?: unknown } = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'OpenCodeError';
    this.kind = kind;
    if (details.status !== undefined) this.status = details.status;
    if (details.code) this.code = details.code;
  }

  get retryable(): boolean {
    return this.kind === 'overloaded' || this.kind === 'timeout';
  }
}

/** OpenCode's error object, as `session.error` and an assistant message carry it. */
export interface OpenCodeErrorPayload {
  name?: string;
  data?: { message?: string; statusCode?: number; isRetryable?: boolean; responseBody?: string; providerID?: string };
}

/**
 * The free models' allowance ran out (`FreeUsageLimitError`), or another usage or rate limit:
 * the Zen API says so in its message or body, with a 429.
 */
const USAGE_LIMIT_RE = /free\s*usage\s*limit|FreeUsageLimitError|usage\s+limit|rate[\s_-]*limit|too\s+many\s+requests|subscribe\s+to\s+opencode\s+go/i;
const AUTH_RE = /unauthori[sz]ed|authentication|invalid\s+api\s+key|api\s+key\s+(?:is\s+)?(?:missing|invalid)|\b401\b|\b403\b/i;
const CONTEXT_RE = /context\s*(?:window|length|overflow)|maximum\s+context|too\s+many\s+tokens/i;
const MODEL_UNAVAILABLE_RE = /model\s+(?:is\s+)?(?:unavailable|not\s+found|not\s+supported|does\s+not\s+exist)|unknown\s+model|ProviderModelNotFound/i;
const OVERLOADED_RE = /overloaded|server\s+error|service\s+unavailable|bad\s+gateway|timed?\s*out/i;

/** The message a person reads for an OpenCode error: its message, else its name. */
function messageOf(error: OpenCodeErrorPayload | undefined, fallback: string): string {
  const body = error?.data?.responseBody;
  let bodyMessage: string | undefined;
  if (body) {
    try {
      const parsed = JSON.parse(body) as { error?: { message?: unknown } | string; message?: unknown };
      const nested = typeof parsed.error === 'object' ? parsed.error?.message : parsed.error;
      bodyMessage = [nested, parsed.message].find((value): value is string => typeof value === 'string' && value.trim() !== '');
    } catch {
      bodyMessage = undefined;
    }
  }
  return [error?.data?.message, bodyMessage, error?.name].find((value): value is string => typeof value === 'string' && value.trim() !== '') ?? fallback;
}

/**
 * A turn's failure as an {@link OpenCodeError}. Deterministic failures (the model is gone, the
 * context is full) win over the transient words they may also hold.
 */
export function openCodeErrorFrom(error: OpenCodeErrorPayload | undefined, fallback = 'The OpenCode turn failed.'): OpenCodeError {
  const message = messageOf(error, fallback);
  const status = error?.data?.statusCode;
  const haystack = [message, error?.data?.responseBody ?? '', error?.name ?? ''].join('\n');
  const details = { ...(status !== undefined ? { status } : {}), ...(error?.name ? { code: error.name } : {}) };
  if (error?.name === 'ContextOverflowError' || CONTEXT_RE.test(haystack)) return new OpenCodeError('context', message, details);
  if (MODEL_UNAVAILABLE_RE.test(haystack) || status === 404) return new OpenCodeError('model_unavailable', message, details);
  if (status === 429 || USAGE_LIMIT_RE.test(haystack)) return new OpenCodeError('rate_limit', message, details);
  if (error?.name === 'ProviderAuthError' || status === 401 || status === 403 || AUTH_RE.test(haystack)) return new OpenCodeError('auth', message, details);
  if ((status !== undefined && status >= 500) || OVERLOADED_RE.test(haystack)) return new OpenCodeError('overloaded', message, details);
  return new OpenCodeError('unknown', message, details);
}

/** Whether a `retry` status's message is a limit no retry gets past (the free allowance, a usage cap). */
export function isTerminalRetry(message: string): boolean {
  return USAGE_LIMIT_RE.test(message) || AUTH_RE.test(message) || MODEL_UNAVAILABLE_RE.test(message);
}
