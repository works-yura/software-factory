/**
 * Runs a harness CLI's own sign-in command (`claude auth login`, `codex login`) to its end, for a
 * sign-in the server runs on its machine (see `../claude/sign-in.ts`, `../codex/sign-in.ts`). The
 * CLI opens the sign-in page in a browser there and waits for it; this only starts it, keeps its
 * output, and stops it on a timeout or a cancel so it cannot finish the sign-in afterwards.
 */

import { spawn as nodeSpawn } from 'node:child_process';

export interface SignInCommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs one command to its end. Rejects only when it cannot start, runs past its timeout, or is cancelled. */
export type SignInCommandRunner = (
  command: string,
  args: string[],
  options: { env: Record<string, string>; timeoutMs: number; signal?: AbortSignal },
) => Promise<SignInCommandResult>;

/** How long a CLI that was told to stop (SIGTERM) gets before it is killed. */
const STOP_GRACE_MS = 5_000;

/**
 * A {@link SignInCommandRunner} that spawns the command with stdio piped (stdin stays open: a CLI
 * may wait for a code pasted there) and rejects with the provider's own error type, so its message
 * reaches the person.
 *
 * A timeout or a cancel stops the CLI (SIGTERM, then SIGKILL after a grace period) and rejects
 * only once it has exited: the caller then removes the throwaway sign-in dir and the Keychain item,
 * and a CLI still running could finish the sign-in after that, into the person's own login.
 */
export function createSignInCommandRunner({
  name,
  error,
  stopGraceMs = STOP_GRACE_MS,
}: {
  /** How the provider names itself in a cancel ("Claude", "ChatGPT"). */
  name: string;
  error: (message: string) => Error;
  stopGraceMs?: number;
}): SignInCommandRunner {
  return (command, args, { env, timeoutMs, signal }) =>
    new Promise((resolve, reject) => {
      const cancelled = () => error(`${name} sign-in was cancelled.`);
      // Cancelled before it started: nothing to run (an abort listener would never fire).
      if (signal?.aborted) {
        reject(cancelled());
        return;
      }
      const child = nodeSpawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let settled = false;
      let stopped: Error | undefined;
      let killTimer: NodeJS.Timeout | undefined;
      const finish = (settle: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(killTimer);
        signal?.removeEventListener('abort', abort);
        settle();
      };
      const stop = (why: Error) => {
        if (stopped || settled) return;
        stopped = why;
        clearTimeout(timer);
        child.kill('SIGTERM');
        killTimer = setTimeout(() => child.kill('SIGKILL'), stopGraceMs);
        killTimer.unref?.();
      };
      const timer = setTimeout(() => stop(error(`${command} ${args[0] ?? ''} timed out.`)), timeoutMs);
      const abort = () => stop(cancelled());
      signal?.addEventListener('abort', abort, { once: true });
      child.stdout?.on('data', chunk => (stdout += String(chunk)));
      child.stderr?.on('data', chunk => (stderr += String(chunk)));
      child.on('error', cause => finish(() => reject(stopped ?? error(`${command} could not start: ${cause.message}`))));
      // A stopped CLI is done once it exited, even if something it started still holds its pipes.
      child.on('exit', () => {
        if (stopped) finish(() => reject(stopped));
      });
      child.on('close', code => finish(() => (stopped ? reject(stopped) : resolve({ code, stdout, stderr }))));
    });
}
