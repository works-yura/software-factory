/**
 * What a session's sandbox setup is doing right now, for the chat to show in
 * place of a bare "thinking" while the first turn waits on it.
 *
 * The setup (clone, branch checkout, env files, setup commands — one or several
 * repositories) reports each step to a {@link SandboxSetupReporter}; the
 * reporter turns them into {@link SandboxSetupProgressEvent}s for the session
 * and hands them to whoever listens ({@link onSandboxSetupProgress}). The host
 * forwards them onto the session's own event stream, whichever harness runs it.
 * Nothing is stored: a page opened mid-setup sees the next step.
 */

/** The event type on the session's stream. */
export const SANDBOX_SETUP_EVENT = 'factory_sandbox_setup';

/**
 * - `clone`: the repository is being cloned;
 * - `checkout`: the session branch is being fetched and checked out;
 * - `env-files`: the factory's env files are being written into the checkout;
 * - `setup`: a setup command (usually a dependency install) runs; without a
 *   repository it is the workspace's own setup command.
 */
export type SandboxSetupPhase = 'clone' | 'checkout' | 'env-files' | 'setup';

/**
 * Why a step failed, for the chat to name in the viewer's language:
 * - `timeout`: a command or transfer ran out of time (e.g. a stalled clone);
 * - `network`: the sandbox could not reach the git host;
 * - `no_access`: the git host refused the repository;
 * - `clone_failed`: git failed to clone or check out for another reason;
 * - `setup_failed`: a setup command exited non-zero;
 * - `unknown`: anything else; its message is all there is.
 */
export type SandboxSetupFailureCode = 'timeout' | 'network' | 'no_access' | 'clone_failed' | 'setup_failed' | 'unknown';

export interface SandboxSetupFailure {
  code: SandboxSetupFailureCode;
  /** The server's own message, in English, shown under the translated line. */
  message: string;
  phase?: SandboxSetupPhase;
  /** The repository's slug (`owner/name`); absent for the workspace setup command. */
  repo?: string;
}

/** A clone's transfer so far, read from `git clone --progress`. */
export interface SandboxSetupTransfer {
  receivedBytes?: number;
  /** Objects received, 0–100. */
  percent?: number;
}

export interface SandboxSetupProgressEvent extends SandboxSetupTransfer {
  type: typeof SANDBOX_SETUP_EVENT;
  /** `running` until the setup ends; then `failed` when any step failed, even one the setup went on without. */
  status: 'running' | 'done' | 'failed';
  /** Since the setup began. */
  elapsedMs: number;
  /** The step in progress (running) or the last one (done, failed). */
  phase?: SandboxSetupPhase;
  repo?: string;
  /** The repository's position among the session's repositories, from 1. */
  index?: number;
  total: number;
  failures?: SandboxSetupFailure[];
}

export interface SandboxSetupReporter {
  /** A repository (or, without one, the workspace) enters a step. */
  step(phase: SandboxSetupPhase, repo?: string): void;
  /** A clone moved on; sent at most every so often. */
  transfer(repo: string, transfer: SandboxSetupTransfer): void;
  /** A step failed and the setup goes on without it; `at` defaults to the repository's last step. */
  fail(error: unknown, at?: { repo?: string; phase?: SandboxSetupPhase }): void;
  /** The setup ended; with an error it failed at the last step that began. */
  finish(error?: unknown): void;
}

export type SandboxSetupProgressListener = (sessionId: string, event: SandboxSetupProgressEvent) => void;

const listeners = new Set<SandboxSetupProgressListener>();

/** Hear every session's setup progress; returns the unsubscribe. */
export function onSandboxSetupProgress(listener: SandboxSetupProgressListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function publish(sessionId: string, event: SandboxSetupProgressEvent): void {
  for (const listener of [...listeners]) {
    try {
      listener(sessionId, event);
    } catch (error) {
      console.warn('[factory] Sandbox setup progress listener failed', error);
    }
  }
}

const TIMEOUT = /timed out|timeout|too slow|stalled|low speed/i;
const NETWORK = /could not reach|could not resolve host|failed to connect|network is unreachable|egress/i;
const NO_ACCESS =
  /authentication failed|could not read username|repository not found|permission denied|access denied|\b40[134]\b|not authorized|did not include usable credentials/i;
const GIT_FAILURE_CODES = new Set(['clone-failed', 'pull-failed', 'git-missing']);

/**
 * Sort a sandbox start or setup failure by what the person can do about it,
 * keeping its message. `MaterializeError` and `SetupCommandError` are matched
 * by shape so callers outside this package need no import.
 */
export function classifySandboxFailure(error: unknown): { code: SandboxSetupFailureCode; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : undefined;
  const code = error instanceof Error ? (error as Error & { code?: unknown }).code : undefined;
  if (code === 'egress-blocked') return { code: 'network', message };
  if (name === 'SetupCommandError') return { code: 'setup_failed', message };
  if (TIMEOUT.test(message)) return { code: 'timeout', message };
  if (NETWORK.test(message)) return { code: 'network', message };
  if (NO_ACCESS.test(message)) return { code: 'no_access', message };
  if (typeof code === 'string' && GIT_FAILURE_CODES.has(code)) return { code: 'clone_failed', message };
  if (/\bgit (clone|checkout|fetch)\b/i.test(message)) return { code: 'clone_failed', message };
  return { code: 'unknown', message };
}

/** The longest failure message an event carries; git's stderr can run long. */
const MAX_FAILURE_MESSAGE = 1000;
/** How often a clone's transfer is reported at most. */
const TRANSFER_INTERVAL_MS = 1000;

/** A reporter that reports nothing, for setups nobody watches. */
export const silentSandboxSetupReporter: SandboxSetupReporter = {
  step() {},
  transfer() {},
  fail() {},
  finish() {},
};

/**
 * The reporter for one setup of a session's sandbox, which announces the
 * setup as it is created. `repos` are the session's repositories in the order
 * the session lists them; a step names its repository's position among them.
 */
export function createSandboxSetupReporter(
  sessionId: string,
  repos: readonly string[],
  { now = Date.now, transferIntervalMs = TRANSFER_INTERVAL_MS }: { now?: () => number; transferIntervalMs?: number } = {},
): SandboxSetupReporter {
  const startedAt = now();
  const total = Math.max(repos.length, 1);
  const lastPhase = new Map<string | undefined, SandboxSetupPhase>();
  const failures: SandboxSetupFailure[] = [];
  // An error already reported by `fail` that the setup then rethrows is not a second failure.
  const recorded = new Set<unknown>();
  let current: { phase?: SandboxSetupPhase; repo?: string } = {};
  let lastTransferAt = Number.NEGATIVE_INFINITY;
  let finished = false;

  const position = (repo: string | undefined) => {
    if (repo === undefined) return undefined;
    const index = repos.findIndex(candidate => candidate.toLowerCase() === repo.toLowerCase());
    return index === -1 ? undefined : index + 1;
  };
  const emit = (status: SandboxSetupProgressEvent['status'], transfer: SandboxSetupTransfer = {}) => {
    const index = position(current.repo);
    publish(sessionId, {
      type: SANDBOX_SETUP_EVENT,
      status,
      elapsedMs: Math.max(0, now() - startedAt),
      total,
      ...(current.phase ? { phase: current.phase } : {}),
      ...(current.repo !== undefined ? { repo: current.repo } : {}),
      ...(index !== undefined ? { index } : {}),
      ...(transfer.receivedBytes !== undefined ? { receivedBytes: transfer.receivedBytes } : {}),
      ...(transfer.percent !== undefined ? { percent: transfer.percent } : {}),
      ...(failures.length ? { failures: failures.map(failure => ({ ...failure })) } : {}),
    });
  };
  const record = (error: unknown, at: { repo?: string; phase?: SandboxSetupPhase }) => {
    if (recorded.has(error)) return;
    recorded.add(error);
    const { code, message } = classifySandboxFailure(error);
    const phase = at.phase ?? lastPhase.get(at.repo);
    failures.push({
      code,
      message: message.length > MAX_FAILURE_MESSAGE ? `…${message.slice(-MAX_FAILURE_MESSAGE)}` : message,
      ...(phase ? { phase } : {}),
      ...(at.repo !== undefined ? { repo: at.repo } : {}),
    });
  };

  // The chat names the setup at once, before its first step is known.
  emit('running');
  return {
    step(phase, repo) {
      if (finished) return;
      lastPhase.set(repo, phase);
      current = { phase, ...(repo !== undefined ? { repo } : {}) };
      lastTransferAt = Number.NEGATIVE_INFINITY;
      emit('running');
    },
    transfer(repo, transfer) {
      if (finished) return;
      const at = now();
      if (at - lastTransferAt < transferIntervalMs) return;
      lastTransferAt = at;
      current = { phase: 'clone', repo };
      emit('running', transfer);
    },
    fail(error, at) {
      if (finished) return;
      record(error, at ?? current);
      emit('running');
    },
    finish(error) {
      if (finished) return;
      finished = true;
      if (error !== undefined) record(error, current);
      emit(failures.length ? 'failed' : 'done');
    },
  };
}

const PROGRESS_UNITS: Record<string, number> = { bytes: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 };
const RECEIVING = /Receiving objects:\s+(\d{1,3})%[^\r\n]*?(?:,\s+([\d.]+)\s+(bytes|KiB|MiB|GiB))?(?:\s+\||,\s+done|\s*$)/;
/** A progress line git rewrites in place: `Receiving objects:  45% (1234/2741), 12.34 MiB | 2.10 MiB/s`. */
const PROGRESS_LINE = /^(?:remote: )?[A-Z][a-z]+(?: [a-z]+)*:\s+\d{1,3}% \(/;

/**
 * Reads `git clone --progress` stderr as it streams: each chunk may end
 * mid-line, so the unfinished tail waits for the next one. Answers the newest
 * transfer state a chunk completed, if any.
 */
export function gitProgressReader(): (chunk: string) => SandboxSetupTransfer | undefined {
  let tail = '';
  return chunk => {
    const lines = (tail + chunk).split(/[\r\n]/);
    tail = lines.pop() ?? '';
    let latest: SandboxSetupTransfer | undefined;
    for (const line of lines) {
      const match = RECEIVING.exec(line);
      if (!match) continue;
      const amount = match[2] !== undefined ? Number(match[2]) : undefined;
      latest = {
        percent: Number(match[1]),
        ...(amount !== undefined && Number.isFinite(amount)
          ? { receivedBytes: Math.round(amount * PROGRESS_UNITS[match[3]!]!) }
          : {}),
      };
    }
    return latest;
  };
}

/** Drop the progress lines `--progress` adds, so a failed clone's message is git's actual complaint. */
export function withoutGitProgress(stderr: string): string {
  return stderr
    .split(/\r\n|\r|\n/)
    .filter(line => !PROGRESS_LINE.test(line.trim()))
    .join('\n')
    .trim();
}
