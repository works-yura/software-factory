/**
 * Sandbox starts the Files tab asked for, run in the background of this process.
 *
 * Starting a sandbox can clone several repositories and take minutes, longer than the server lets
 * a request run, so the start route kicks it off here and returns at once. A second request for a
 * session joins the start already running instead of cloning again. The workspace tree reads the
 * state back: `starting` while it runs, and why it failed until the next start.
 */

/**
 * What kind of failure ended a start, for the page to name in the viewer's language:
 * - `timeout`: a command or transfer ran out of time (e.g. a clone from a slow GitHub);
 * - `network`: the sandbox could not reach the git host;
 * - `no_access`: the git host refused the repository (credentials, permissions, not found);
 * - `clone_failed`: git failed to clone or check out for another reason;
 * - `no_sandbox`: the session has no sandbox, or no checkout, to start;
 * - `unknown`: anything else; its message is all there is.
 */
export type SessionSandboxStartErrorCode = 'timeout' | 'network' | 'no_access' | 'clone_failed' | 'no_sandbox' | 'unknown';

export interface SessionSandboxStartError {
  code: SessionSandboxStartErrorCode;
  /** The server's own message, in English, as the detail under the page's translated line. */
  message: string;
}

export interface SessionSandboxStartState {
  /** A start is running for the session. */
  starting: boolean;
  /** Why the last start failed, until the next one begins. */
  error?: SessionSandboxStartError;
}

/** Thrown by a start that finds nothing to start; classified as `no_sandbox`. */
export class NothingToStartError extends Error {
  override readonly name = 'NothingToStartError';
}

const TIMEOUT = /timed out|timeout|too slow|stalled|low speed/i;
const NETWORK = /could not reach|could not resolve host|failed to connect|network is unreachable|egress/i;
const NO_ACCESS =
  /authentication failed|could not read username|repository not found|permission denied|access denied|\b40[134]\b|not authorized|did not include usable credentials/i;
const GIT_FAILURE_CODES = new Set(['clone-failed', 'pull-failed', 'git-missing']);

/** Sort a start failure into a {@link SessionSandboxStartErrorCode}, keeping its message. */
export function classifySessionSandboxStartError(error: unknown): SessionSandboxStartError {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof NothingToStartError) return { code: 'no_sandbox', message };
  // `MaterializeError` (sandbox package) carries a code; matched by shape so no import is needed.
  const materialize = error instanceof Error ? (error as Error & { code?: unknown }).code : undefined;
  if (materialize === 'egress-blocked') return { code: 'network', message };
  if (TIMEOUT.test(message)) return { code: 'timeout', message };
  if (NETWORK.test(message)) return { code: 'network', message };
  if (NO_ACCESS.test(message)) return { code: 'no_access', message };
  if (typeof materialize === 'string' && GIT_FAILURE_CODES.has(materialize)) return { code: 'clone_failed', message };
  if (/\bgit (clone|checkout|fetch)\b/i.test(message)) return { code: 'clone_failed', message };
  return { code: 'unknown', message };
}

interface StartEntry {
  running?: Promise<void>;
  error?: SessionSandboxStartError;
}

const starts = new Map<string, StartEntry>();

/**
 * Run `start` for the session in the background unless one already runs: `'joined'` then. A
 * failure is logged and kept for {@link sessionSandboxStartState}; it never rejects to the caller.
 */
export function startSessionSandboxInBackground(sessionId: string, start: () => Promise<void>): 'started' | 'joined' {
  if (starts.get(sessionId)?.running) return 'joined';
  const entry: StartEntry = {};
  starts.set(sessionId, entry);
  entry.running = (async () => {
    try {
      await start();
      if (starts.get(sessionId) === entry) starts.delete(sessionId);
    } catch (error) {
      console.error('[Factory Sessions] Failed to start session sandbox', { sessionId, error });
      entry.error = classifySessionSandboxStartError(error);
    } finally {
      entry.running = undefined;
    }
  })();
  return 'started';
}

/** Whether a background start runs for the session, and why its last one failed. */
export function sessionSandboxStartState(sessionId: string): SessionSandboxStartState {
  const entry = starts.get(sessionId);
  if (!entry) return { starting: false };
  return { starting: entry.running !== undefined, ...(entry.error !== undefined ? { error: entry.error } : {}) };
}

/** Resolves when the session's background start settles (at once when none runs). */
export async function settledSessionSandboxStart(sessionId: string): Promise<void> {
  await starts.get(sessionId)?.running;
}
