/**
 * Commands the server runs on its own host for the local environment template:
 * mirror upkeep, build checkouts, session work snapshots. Shaped as an
 * {@link ExecutableSandbox} so the git helpers that run inside a session's
 * sandbox (hang guard, stall abort, read-only retries) run here unchanged.
 */

import { spawn } from 'node:child_process';

import type { ExecutableSandbox, SandboxCommandResult } from '../materialization.ts';

/** Output kept per stream; git's progress and a failing install can run long. */
const MAX_OUTPUT = 256 * 1024;

export interface HostExecutorOptions {
  /** Environment every command starts from (the local sandbox's allow-list); `PATH` is the server's. */
  env?: Record<string, string>;
  /** Default working directory. */
  cwd?: string;
}

function keepTail(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length > MAX_OUTPUT ? next.slice(-MAX_OUTPUT) : next;
}

/**
 * Run commands on the server host. Each command is killed (its whole process
 * group) when its `timeout` passes, so a hung git never outlives its budget;
 * the result then carries exit code 124 and a timeout message.
 */
export function hostExecutor(options: HostExecutorOptions = {}): ExecutableSandbox {
  return {
    id: 'factory-host',
    executeCommand(command, args = [], commandOptions = {}): Promise<SandboxCommandResult> {
      const env: Record<string, string> = {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        ...options.env,
      };
      for (const [key, value] of Object.entries(commandOptions.env ?? {})) {
        if (value === undefined) delete env[key];
        else env[key] = value;
      }
      // Never let git stop to ask for credentials on the server.
      env.GIT_TERMINAL_PROMPT = '0';
      return new Promise(resolve => {
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        const child = spawn(command, args, {
          cwd: commandOptions.cwd ?? options.cwd ?? process.cwd(),
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true,
        });
        const timeout = commandOptions.timeout;
        const timer =
          timeout && timeout > 0
            ? setTimeout(() => {
                timedOut = true;
                try {
                  if (child.pid) process.kill(-child.pid, 'SIGKILL');
                } catch {
                  child.kill('SIGKILL');
                }
              }, timeout)
            : undefined;
        timer?.unref?.();
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
          stdout = keepTail(stdout, chunk);
        });
        child.stderr.on('data', (chunk: string) => {
          stderr = keepTail(stderr, chunk);
          commandOptions.onStderr?.(chunk);
        });
        child.on('error', error => {
          clearTimeout(timer);
          resolve({ exitCode: 127, stdout, stderr: keepTail(stderr, error.message) });
        });
        child.on('close', code => {
          clearTimeout(timer);
          if (timedOut) {
            resolve({
              exitCode: 124,
              stdout,
              stderr: keepTail(stderr, `\nCommand timed out after ${Math.round((timeout ?? 0) / 1000)}s.`),
            });
            return;
          }
          resolve({ exitCode: code ?? 1, stdout, stderr });
        });
      });
    },
  };
}
