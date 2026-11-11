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

/**
 * A {@link SignInCommandRunner} that spawns the command with stdio piped (stdin stays open: a CLI
 * may wait for a code pasted there) and rejects with the provider's own error type, so its message
 * reaches the person.
 */
export function createSignInCommandRunner({
  name,
  error,
}: {
  /** How the provider names itself in a cancel ("Claude", "ChatGPT"). */
  name: string;
  error: (message: string) => Error;
}): SignInCommandRunner {
  return (command, args, { env, timeoutMs, signal }) =>
    new Promise((resolve, reject) => {
      const child = nodeSpawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (settle: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        settle();
      };
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        finish(() => reject(error(`${command} ${args[0] ?? ''} timed out.`)));
      }, timeoutMs);
      const abort = () => {
        child.kill('SIGTERM');
        finish(() => reject(error(`${name} sign-in was cancelled.`)));
      };
      signal?.addEventListener('abort', abort, { once: true });
      child.stdout?.on('data', chunk => (stdout += String(chunk)));
      child.stderr?.on('data', chunk => (stderr += String(chunk)));
      child.on('error', cause => finish(() => reject(error(`${command} could not start: ${cause.message}`))));
      child.on('close', code => finish(() => resolve({ code, stdout, stderr })));
    });
}
