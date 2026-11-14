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
  /** When a usage limit comes back, when someone said (the account's usage windows, the account pool). */
  readonly resetsAt?: Date;

  constructor(kind: OpenCodeErrorKind, message: string, details: { status?: number; code?: string; cause?: unknown; resetsAt?: Date } = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'OpenCodeError';
    this.kind = kind;
    if (details.status !== undefined) this.status = details.status;
    if (details.code) this.code = details.code;
    if (details.resetsAt) this.resetsAt = details.resetsAt;
  }

  /** The same failure, now knowing when its limit comes back. */
  withResetsAt(resetsAt: Date): OpenCodeError {
    return new OpenCodeError(this.kind, this.message, {
      ...(this.status !== undefined ? { status: this.status } : {}),
      ...(this.code ? { code: this.code } : {}),
      cause: this,
      resetsAt,
    });
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
const USAGE_LIMIT_RE = /free\s*usage\s*limit|FreeUsageLimitError|GoUsageLimitError|usage\s+limit|rate[\s_-]*limit|too\s+many\s+requests|subscribe\s+to\s+opencode\s+go|budget\s+exceeded/i;
/** A limit that holds until someone pays or a window resets: OpenCode's own retries never get past it. */
const EXHAUSTED_RE = /free\s*usage\s*limit|FreeUsageLimitError|GoUsageLimitError|usage\s+limit|subscribe\s+to\s+opencode\s+go|budget\s+exceeded/i;
/** A bare 401 or 403 is no proof (a port, a count): only beside the words HTTP or status. */
const AUTH_RE = /unauthori[sz]ed|authentication|invalid\s+api\s+key|api\s+key\s+(?:is\s+)?(?:missing|invalid)|(?:HTTP|status(?:\s+code)?)\s*:?\s*40[13]\b/i;
const CONTEXT_RE = /context\s*(?:window|length|overflow)|maximum\s+context|too\s+many\s+tokens/i;
const MODEL_UNAVAILABLE_RE = /model\s+(?:is\s+)?(?:unavailable|not\s+found|not\s+supported|does\s+not\s+exist)|unknown\s+model|ProviderModelNotFound/i;
const OVERLOADED_RE = /overloaded|server\s+error|service\s+unavailable|bad\s+gateway|timed?\s*out/i;

/** A URL in a provider's words without what a reader must not see: its credentials, query and fragment. */
function sanitizeUrls(text: string): string {
  return text.replace(/\bhttps?:\/\/[^\s"'<>)]+/gi, raw => {
    try {
      const url = new URL(raw);
      return `${url.protocol}//${url.host}${url.pathname === '/' && !raw.endsWith('/') ? '' : url.pathname}`;
    } catch {
      return raw.replace(/\/\/[^/@\s]*@/, '//').replace(/[?#].*$/, '');
    }
  });
}

/** OpenCode writes `<none>` when it could not read the provider's message. */
const meaningful = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '' && value.trim().toLowerCase() !== '<none>';

/**
 * The message a person reads for an OpenCode error: its message, else the provider's (a JSON body's
 * message, an HTML page's title with the status), else what the status says, else its name.
 */
function messageOf(error: OpenCodeErrorPayload | undefined, fallback: string): string {
  const body = error?.data?.responseBody;
  const status = error?.data?.statusCode;
  let bodyMessage: string | undefined;
  if (body) {
    try {
      const parsed = JSON.parse(body) as { error?: { message?: unknown } | string; message?: unknown };
      const nested = typeof parsed.error === 'object' ? parsed.error?.message : parsed.error;
      bodyMessage = [nested, parsed.message].find(meaningful);
    } catch {
      const title = /<title[^>]*>([^<]*)<\/title>/i.exec(body)?.[1]?.replace(/\s+/g, ' ').trim();
      if (title) bodyMessage = typeof status === 'number' ? `${title} (HTTP ${status}).` : title;
    }
  }
  const statusMessage = typeof status === 'number' ? `The model provider failed the request (HTTP ${status}).` : undefined;
  const unnamed = typeof error?.data?.message === 'string' && !meaningful(error.data.message) ? 'The model provider failed the request and did not include an error message.' : undefined;
  const message = [error?.data?.message, bodyMessage, statusMessage, unnamed, error?.name].find(meaningful) ?? fallback;
  return sanitizeUrls(message.trim());
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

/**
 * Whether a `retry` status's message is a limit no retry gets past (the free allowance, a usage cap).
 * A rate limit per minute is not: OpenCode's retry waits it out, and the turn goes on.
 */
export function isTerminalRetry(message: string): boolean {
  return EXHAUSTED_RE.test(message) || AUTH_RE.test(message) || MODEL_UNAVAILABLE_RE.test(message);
}
