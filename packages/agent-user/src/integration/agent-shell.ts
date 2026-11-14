/**
 * Test support for the real-user suites: the agent user from FACTORY_AGENT_USER_TEST, whether
 * this machine is set up for it, and a shell run as the agent (through the real launcher) or as
 * the server. Not used by Factory itself.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

import type { AgentUserConfig } from '../config/agent-user-config.ts';
import { agentUserFromEnv } from '../config/from-env.ts';
import { createProcessSpawner } from '../spawn/create-spawner.ts';

export interface ShellResult {
  code: number | null;
  out: string;
  err: string;
}

export const agentUserTest = process.env.FACTORY_AGENT_USER_TEST?.trim();
export const sandboxRoot = process.env.FACTORY_AGENT_USER_TEST_ROOT ?? '/Volumes/dot/Project/factory/sandboxes';

/** The agent user as the server would configure it; `seatbelt: 'off'` is how prod runs it. */
export function agentConfig(seatbelt: 'on' | 'off' = 'on'): AgentUserConfig | undefined {
  if (!agentUserTest) return undefined;
  return agentUserFromEnv({ FACTORY_AGENT_USER: agentUserTest, FACTORY_AGENT_SEATBELT: seatbelt }, { serverUser: process.env.USER ?? '', sandboxRoot });
}

/** The sudoers rule and the profile are installed (`scripts/mac-mini/isolation/2-system.sh`). */
export function agentUserReady(config = agentConfig()): boolean {
  const ready = Boolean(
    config && existsSync(config.profilePath) && spawnSync('/usr/bin/sudo', ['-n', '-u', config.user, '--', '/usr/bin/env', 'true']).status === 0,
  );
  if (process.env.FACTORY_AGENT_USER_TEST_STRICT === '1' && !ready) throw new Error('The agent user is not set up (sudoers rule, profile).');
  return ready;
}

function collect(child: ReturnType<typeof spawn>): Promise<ShellResult> {
  let out = '';
  let err = '';
  child.stdout?.on('data', chunk => (out += chunk));
  child.stderr?.on('data', chunk => (err += chunk));
  return new Promise(resolve => child.on('close', code => resolve({ code, out, err })));
}

/** `sh -c script` as the agent user, in the card folders, through the launcher Factory uses. */
export function asAgent(config: AgentUserConfig | undefined, script: string, env: Record<string, string> = {}): Promise<ShellResult> {
  const child = createProcessSpawner(config).spawn({ command: '/bin/sh', args: ['-c', script], env }, { cwd: sandboxRoot });
  child.stdin?.end();
  return collect(child as ReturnType<typeof spawn>);
}

/** `sh -c script` as the server user: the control that shows a refused probe is not just broken. */
export function asServer(script: string): Promise<ShellResult> {
  return collect(spawn('/bin/sh', ['-c', script], { stdio: ['ignore', 'pipe', 'pipe'] }));
}
