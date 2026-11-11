// A turn-based session (Claude Code, Codex) whose run stopped because every account it may use is
// out of usage does not wait for the person's next message: it parks "until X" (when the first
// account comes back, or a cooldown when nobody said) and the host resumes it at X. What waits is
// kept with the session: its pending inputs, and, when the interrupted turn had already reached the
// model, a note that the next turn goes on where that one stopped.
//
// The session records the park and announces it (`usage_limit_parked`); the host's scheduler
// (timer per parked session, plus a scan of the stores on startup) calls `resumeFromUsageLimit()`
// at X. A resume that runs into the limit again parks anew, until {@link USAGE_LIMIT_PARK_MAX_MS}
// after the first park, when the run fails for good with a clear error.

/** Why a session is parked; one reason for now. */
export type UsageLimitParkReason = 'usage_limit';

/** A session parked on a usage limit, as its store keeps it (it survives a restart). */
export interface UsageLimitPark {
  reason: UsageLimitParkReason;
  /** When the session resumes on its own (ISO). */
  until: string;
  /** Whether `until` is the provider's own reset time, rather than a cooldown guessed here. */
  resetKnown: boolean;
  /** When the session first parked on this limit (ISO); the cap counts from here. */
  since: string;
  /** How many times it parked on this limit (1 for the first park; a failed resume adds one). */
  attempts: number;
  /** The provider's or the account pool's words. */
  message: string;
  /** The interrupted turn reached the model: the resume tells it to go on instead of resending the request. */
  continueTurn?: true;
}

/** Emitted (besides the contract's events) when a session parks on a usage limit, or parks again. */
export interface UsageLimitParkedEvent {
  type: 'usage_limit_parked';
  park: UsageLimitPark;
}

/** Emitted when a parked session is no longer parked: a run took it up, or it gave up waiting. */
export interface UsageLimitClearedEvent {
  type: 'usage_limit_cleared';
  reason: 'resumed' | 'expired';
}

export type UsageLimitParkEvent = UsageLimitParkedEvent | UsageLimitClearedEvent;

/** What `resumeFromUsageLimit()` did. */
export type UsageLimitResumeResult =
  /** A run started (the session had something to resume) and got past its credentials. */
  | { action: 'resumed'; runId: string }
  /** The resume ran into the limit again: the session parked anew. */
  | { action: 'parked'; park: UsageLimitPark }
  /** A run is already in flight; nothing to do. */
  | { action: 'running' }
  /** The session is not parked. */
  | { action: 'not_parked' }
  /** The resumed run ended otherwise (another failure, an abort): the session is no longer parked. */
  | { action: 'ended' };

/** How long a session keeps waiting on usage limits before its run fails for good. */
export const USAGE_LIMIT_PARK_MAX_MS = 7 * 24 * 60 * 60_000;
/** The first wait when nobody said when the limit resets; it doubles with each park. */
export const USAGE_LIMIT_PARK_FIRST_COOLDOWN_MS = 5 * 60_000;
/** The longest wait when nobody said when the limit resets: the account pool's own cooldown. */
export const USAGE_LIMIT_PARK_MAX_COOLDOWN_MS = 60 * 60_000;

/** Sent ahead of the pending input when a resumed session goes on with a turn the limit cut off. */
export const USAGE_LIMIT_RESUME_PROMPT =
  'Your previous attempt at this request stopped because every account ran out of usage. Usage is available again. Continue where you stopped.';

/** A turn-based harness's usage-limit failure (`ClaudeCodeError`/`CodexError` of kind `rate_limit`). */
export interface UsageLimitFailure {
  kind: 'rate_limit';
  message: string;
  resetsAt?: Date;
}

export function isUsageLimitFailure(error: unknown): error is UsageLimitFailure {
  return typeof error === 'object' && error !== null && (error as { kind?: unknown }).kind === 'rate_limit';
}

/** The park a usage-limit failure leads to, or `expired` once the session waited longer than the cap. */
export function nextUsageLimitPark(
  error: UsageLimitFailure,
  {
    previous,
    now = new Date(),
    continueTurn = false,
    maxMs = USAGE_LIMIT_PARK_MAX_MS,
  }: { previous?: UsageLimitPark; now?: Date; continueTurn?: boolean; maxMs?: number } = {},
): UsageLimitPark | 'expired' {
  const since = previous ? new Date(previous.since) : now;
  if (now.getTime() - since.getTime() >= maxMs) return 'expired';
  const attempts = (previous?.attempts ?? 0) + 1;
  const resetsAt = error.resetsAt instanceof Date && !Number.isNaN(error.resetsAt.getTime()) ? error.resetsAt : undefined;
  const until =
    resetsAt && resetsAt.getTime() > now.getTime()
      ? resetsAt
      : new Date(
          now.getTime() +
            Math.min(USAGE_LIMIT_PARK_FIRST_COOLDOWN_MS * 2 ** (attempts - 1), USAGE_LIMIT_PARK_MAX_COOLDOWN_MS),
        );
  return {
    reason: 'usage_limit',
    until: until.toISOString(),
    resetKnown: until === resetsAt,
    since: since.toISOString(),
    attempts,
    message: error.message,
    ...(continueTurn ? { continueTurn: true as const } : {}),
  };
}

/** The message a run ends with once a session waited on usage limits for longer than the cap. */
export function usageLimitExpiredMessage(park: Pick<UsageLimitPark, 'since'> | undefined, message: string): string {
  const since = park ? ` since ${park.since}` : '';
  return `Every account this session may use stayed out of usage${since}; it stopped waiting for the limit to reset. ${message} Send a message to try again.`;
}

/**
 * What a parked session's resume settles on, from the run it started: `resumed` once the run got
 * past its credentials, otherwise whatever its end left (`parked` anew, or `ended`).
 */
export async function usageLimitResumeOutcome(
  run: { runId: string; started: Promise<void>; ended: Promise<unknown> },
  parkAfter: () => UsageLimitPark | undefined,
): Promise<UsageLimitResumeResult> {
  const first = await Promise.race([
    run.started.then(
      () => 'started' as const,
      () => 'failed' as const,
    ),
    run.ended.then(() => 'ended' as const),
  ]);
  if (first === 'started') {
    // A run "starts" as its process spawns; a limit that the provider reports at once still ends it.
    return { action: 'resumed', runId: run.runId };
  }
  await run.ended;
  const park = parkAfter();
  return park ? { action: 'parked', park } : { action: 'ended' };
}
