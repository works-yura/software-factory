/**
 * Stopping agent processes. The server cannot signal another user's processes, so a group the agent
 * user owns is signalled twice: by the server (that reaches sudo, which runs with the server's real
 * uid and passes the signal to its command) and as the agent user through sudo (that reaches every
 * process of the group the agent started: shells, MCP servers, builds). SandVault stops a session the
 * same way: `launchctl bootout` / `pkill -u` as root; here only the agent user's own `kill` is needed.
 */

import { execFile } from 'node:child_process';

import { SUDO } from './command.ts';
import type { AgentUserConfig } from './config.ts';

export const KILL = '/bin/kill';

export type KillRunner = (command: string, args: string[]) => Promise<void>;

const runKill: KillRunner = (command, args) =>
  new Promise(resolve => {
    // A group that is already gone is not an error worth reporting.
    execFile(command, args, { env: { PATH: '/usr/bin:/bin' }, timeout: 10_000 }, () => resolve());
  });

/** The sudo command that sends `signal` to a process group as the agent user. */
export function agentKillArgs(config: AgentUserConfig, processGroup: number, signal: NodeJS.Signals): string[] {
  if (!Number.isInteger(processGroup) || processGroup <= 1) throw new Error(`${processGroup} is not a process group to signal.`);
  return ['-n', '-u', config.user, '--', KILL, '-s', signal.replace(/^SIG/, ''), '--', `-${processGroup}`];
}

/**
 * Sends `signal` to the process group `processGroup` (the pid of the sudo the server spawned
 * detached) both as the server and as the agent user.
 */
export async function signalAgentGroup(
  config: AgentUserConfig,
  processGroup: number,
  signal: NodeJS.Signals,
  run: KillRunner = runKill,
): Promise<void> {
  try {
    process.kill(-processGroup, signal);
  } catch {
    // Only the agent user's processes are left in it, or none.
  }
  await run(SUDO, agentKillArgs(config, processGroup, signal));
}

/** Every process of the agent user, for a server that shuts down or a person who stops all agents. */
export function agentKillAllArgs(config: AgentUserConfig, signal: NodeJS.Signals = 'SIGKILL'): string[] {
  return ['-n', '-u', config.user, '--', KILL, '-s', signal.replace(/^SIG/, ''), '--', '-1'];
}
