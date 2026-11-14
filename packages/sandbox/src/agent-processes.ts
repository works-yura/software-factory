import type { ChildProcess } from 'node:child_process';

/**
 * Runs the commands an agent or a repository asks for as a separate user (ADR-0041,
 * `@factory/agent-user`), not as the server. Unset, they run as the server, as before.
 */
export interface AgentProcesses {
  /**
   * A `sh` program for a caller that can only run a command line (Mastra's `LocalSandbox`): runs
   * `command` (itself a shell command line) as the agent, with `env` as its environment. The values
   * never appear on a command line.
   */
  shellProgram(command: string, env: Record<string, string | undefined>): string;
  /** `command args` as the agent: stdio piped, its own process group; `kill` stops all of it. */
  spawn(command: string, args: readonly string[], options: { cwd: string; env: Record<string, string | undefined> }): ChildProcess;
}
