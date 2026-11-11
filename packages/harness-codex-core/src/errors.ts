// Why a Codex turn failed, in the kinds a Claude Code turn's failure has (`auth`, `rate_limit`, …), so
// the chat and the run reports read both the same way. A usage limit carries when it resets.
import type { CodexErrorInfo, TurnError } from './protocol/schema.ts';

export type CodexErrorKind =
  | 'auth'
  | 'rate_limit'
  | 'overloaded'
  | 'context'
  | 'process'
  | 'timeout'
  | 'unknown_session'
  | 'unknown';

export class CodexError extends Error {
  readonly _tag = 'CodexError';
  readonly kind: CodexErrorKind;
  /** HTTP status Codex reported, when it did. */
  readonly status?: number;
  /** When a usage or rate limit resets, if known. */
  readonly resetsAt?: Date;
  /** Codex's own error code (`usageLimitExceeded`, …), when it named one. */
  readonly code?: string;

  constructor(kind: CodexErrorKind, message: string, details: { status?: number; resetsAt?: Date; code?: string; cause?: unknown } = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'CodexError';
    this.kind = kind;
    if (details.status !== undefined) this.status = details.status;
    if (details.resetsAt) this.resetsAt = details.resetsAt;
    if (details.code) this.code = details.code;
  }

  get retryable(): boolean {
    return this.kind === 'rate_limit' || this.kind === 'overloaded' || this.kind === 'timeout';
  }
}

export function codexErrorInfoCode(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value !== 'object' || value === null) return null;
  return Object.keys(value)[0] ?? null;
}

/**
 * Retry exhaustion only says why it failed through the last attempt's HTTP status. Exhaustion on
 * 429 is a usage or rate limit; other statuses stay provider or transport errors.
 */
export function codexExhaustionHttpStatus(errorInfo: CodexErrorInfo | null | undefined): number | null {
  if (typeof errorInfo !== 'object' || errorInfo === null || !('responseTooManyFailedAttempts' in errorInfo)) return null;
  const attempts = (errorInfo as { responseTooManyFailedAttempts: { httpStatusCode?: number | null } }).responseTooManyFailedAttempts;
  return attempts.httpStatusCode ?? null;
}

function httpStatus(errorInfo: CodexErrorInfo | null | undefined): number | undefined {
  if (typeof errorInfo !== 'object' || errorInfo === null) return undefined;
  const [inner] = Object.values(errorInfo);
  const status = inner && typeof inner === 'object' ? (inner as { httpStatusCode?: unknown }).httpStatusCode : undefined;
  return typeof status === 'number' ? status : undefined;
}

export function codexUsageLimitError(code: string | null, errorInfo: CodexErrorInfo | null | undefined): boolean {
  return code === 'usageLimitExceeded' || code === 'rateLimitExceeded' || codexExhaustionHttpStatus(errorInfo) === 429;
}

const AUTH_RE = /(?:not\s+logged\s+in|codex\s+login|unauthorized|authentication|invalid\s+api\s+key|token\s+(?:has\s+)?expired|\b401\b)/i;
const CONTEXT_RE = /context\s*window|context_length|maximum\s+context/i;
const OVERLOADED_RE = /overloaded|\b5\d\d\b|server\s+error/i;

/** A turn's failure as a {@link CodexError}; `resetsAt` from the account's limits when Codex hit one. */
export function codexErrorFromTurn(error: TurnError, options: { resetsAt?: string | null } = {}): CodexError {
  const code = codexErrorInfoCode(error.codexErrorInfo);
  const status = httpStatus(error.codexErrorInfo);
  const message = [error.message, error.additionalDetails].filter(Boolean).join(' ').trim() || 'The Codex turn failed.';
  const details = {
    ...(status !== undefined ? { status } : {}),
    ...(code ? { code } : {}),
    ...(options.resetsAt ? { resetsAt: new Date(options.resetsAt) } : {}),
  };
  if (codexUsageLimitError(code, error.codexErrorInfo)) return new CodexError('rate_limit', message, details);
  if (code === 'unauthorized' || status === 401 || status === 403 || AUTH_RE.test(message)) return new CodexError('auth', message, details);
  if (code === 'contextWindowExceeded' || CONTEXT_RE.test(message)) return new CodexError('context', message, details);
  if (code === 'serverOverloaded' || (status !== undefined && status >= 500) || OVERLOADED_RE.test(code ?? '')) {
    return new CodexError('overloaded', message, details);
  }
  return new CodexError('unknown', message, details);
}
