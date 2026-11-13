/**
 * Spawning an agent process as the agent user: {@link agentLaunch} with the environment written to
 * its fd 3, in its own process group, and a `kill` that reaches the agent user's processes too.
 * Shaped like Node's `spawn` so a harness that accepts an injected spawn (`ClaudeSpawn`,
 * `CodexSpawn`) can take it as is.
 */

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import type { Writable } from 'node:stream';

import { agentLaunch, type AgentProcessSpec } from './command.ts';
import type { AgentUserConfig } from './config.ts';
import { signalAgentGroup, type KillRunner } from './signal.ts';

export interface SpawnAsAgentOptions {
  cwd: string;
  seatbelt?: boolean;
  /** For tests: the spawn to use instead of Node's, and the runner for the agent-side kill. */
  spawn?: typeof nodeSpawn;
  runKill?: KillRunner;
}

/**
 * Starts `command` as the agent user. The returned child's `kill(signal)` signals the whole group,
 * as the server and as the agent user; stdin, stdout and stderr are pipes, as the harnesses expect.
 */
export function spawnAsAgent(
  config: AgentUserConfig,
  command: string,
  args: readonly string[],
  env: AgentProcessSpec['env'],
  options: SpawnAsAgentOptions,
): ChildProcess {
  const launch = agentLaunch(config, { command, args, env, ...(options.seatbelt === undefined ? {} : { seatbelt: options.seatbelt }) });
  const child = (options.spawn ?? nodeSpawn)(launch.command, launch.args, {
    cwd: options.cwd,
    env: launch.env,
    // Its own group: the group id is the sudo's pid, and everything the agent starts stays in it.
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
  });
  const envPipe = child.stdio[launch.envFd] as Writable | null | undefined;
  if (envPipe) {
    envPipe.on('error', () => {
      // The process died before reading it; its exit says why.
    });
    envPipe.end(launch.envPayload);
  }
  const ownKill = child.kill.bind(child);
  child.kill = (signal: NodeJS.Signals | number = 'SIGTERM') => {
    const name = typeof signal === 'number' ? 'SIGTERM' : signal;
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      void signalAgentGroup(config, child.pid, name, options.runKill);
      return true;
    }
    return ownKill(signal);
  };
  return child;
}
