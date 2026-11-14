/**
 * Everything the server changes when agents run as a separate macOS user (ADR-0041,
 * `FACTORY_AGENT_USER`): one place that reads the configuration and hands each harness what it
 * needs. Unset, nothing changes: agents run as the server's user, as before.
 *
 * Files the server writes for a turn and the CLI reads (config dirs, MCP config and gate script)
 * go under `<sandboxes>/.agent-state`: inside the folder the agent may use, where the
 * `factory-agents` ACLs (`scripts/mac-mini/isolation/2-system.sh agent-group`) let both read
 * them. The server's own records (sessions, database) stay where they were, out of the agent's reach.
 */

import { mkdirSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';

import { agentUserFromEnv, createProcessSpawner, type AgentUserConfig, type ProcessSpawner } from '@factory/agent-user';

import { claudeSpawnAsAgent } from './claude-spawn.ts';

export interface AgentUserRuntime {
  readonly config: AgentUserConfig;
  readonly spawner: ProcessSpawner;
  /** Turn files the agent must read, under the sandboxes folder. */
  readonly stateDir: string;
  /** What the Claude Code harness takes to run its turns as the agent user. */
  claudeCode(): {
    command: string;
    spawn: ReturnType<typeof claudeSpawnAsAgent>;
    sessionConfigRoot: string;
    tempDir: string;
    gateNode: string;
  };
}

export interface AgentUserRuntimeOptions {
  env?: Record<string, string | undefined>;
  /** Where card folders live (`MASTRACODE_LOCAL_SANDBOX_ROOT`). */
  sandboxRoot: string;
  serverUser?: string;
  /** For tests: the spawner to hand out. */
  spawner?: ProcessSpawner;
  /** For tests: no folders are made. */
  makeDirs?: (path: string) => void;
}

const makeDir = (path: string) => mkdirSync(path, { recursive: true, mode: 0o770 });

/** The runtime for this server, or `undefined` when agents run as the server's own user. */
export function agentUserRuntimeFromEnv(options: AgentUserRuntimeOptions): AgentUserRuntime | undefined {
  const env = options.env ?? process.env;
  const config = agentUserFromEnv(env, { serverUser: options.serverUser ?? userInfo().username, sandboxRoot: options.sandboxRoot });
  if (!config) return undefined;
  const spawner = options.spawner ?? createProcessSpawner(config);
  const stateDir = env.FACTORY_AGENT_STATE_DIR?.trim() || join(options.sandboxRoot, '.agent-state');
  const mkdir = options.makeDirs ?? makeDir;
  const claudeConfigRoot = join(stateDir, 'claude-code-config');
  const tempDir = join(stateDir, 'tmp');
  for (const dir of [stateDir, claudeConfigRoot, tempDir]) mkdir(dir);
  return {
    config,
    spawner,
    stateDir,
    claudeCode: () => ({
      // The agent's own `claude` on its PATH: a configured FACTORY_CLAUDE_CODE_COMMAND points into the
      // server user's home, which the agent can neither read nor run.
      command: env.FACTORY_AGENT_CLAUDE_COMMAND?.trim() || 'claude',
      spawn: claudeSpawnAsAgent(spawner),
      sessionConfigRoot: claudeConfigRoot,
      tempDir,
      // On the agent's PATH (its own Node, `<home>/.local/node/bin`): the server's is in a home it cannot read.
      gateNode: 'node',
    }),
  };
}
