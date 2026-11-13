/**
 * Sandbox starts the Files tab asked for, run in the background of this process.
 *
 * Starting a sandbox can clone several repositories and take minutes, longer than the server lets
 * a request run, so the start route kicks it off here and returns at once. A second request for a
 * session joins the start already running instead of cloning again. The workspace tree reads the
 * state back: `starting` while it runs, and why it failed until the next start.
 */

export interface SessionSandboxStartState {
  /** A start is running for the session. */
  starting: boolean;
  /** Why the last start failed, until the next one begins. */
  error?: string;
}

interface StartEntry {
  running?: Promise<void>;
  error?: string;
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
      entry.error = error instanceof Error ? error.message : String(error);
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
