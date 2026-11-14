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
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

import {
  AgentReaper,
  AgentUserSignaller,
  agentUserFromEnv,
  createAgentUserLauncher,
  createProcessSpawner,
  MACOS_SYSTEM_PREFIXES,
  PrivateFileStash,
  PsProcessTable,
  ShellCommandBridge,
  type AgentUserConfig,
  type ProcessSpawner,
} from '@factory/agent-user';
import type { AgentProcesses } from '@factory/sandbox';

import { claudeSpawnAsAgent } from './claude-spawn.ts';
import { codexSpawnAsAgent } from './codex-spawn.ts';
import { openCodeSpawnAsAgent } from './opencode-spawn.ts';

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
    supervisorWorkdirRoot: string;
    tempDir: string;
    gateNode: string;
  };
  /** Sandbox commands (Mastra's agents, session and template setup) as the agent user. */
  readonly processes: AgentProcesses;
  /** What the Codex harness takes to run its sessions as the agent user. */
  codex(): {
    command: string;
    spawn: ReturnType<typeof codexSpawnAsAgent>;
    sessionHomeRoot: string;
    supervisorWorkdirRoot: string;
  };
  /**
   * Stops agent processes no turn owns (daemons, `nohup … &`, turns of a server that restarted):
   * once at start, then every minute. `undefined` with FACTORY_AGENT_REAP=off.
   */
  readonly reaper: AgentReaper | undefined;
  /** What the OpenCode harness takes to run its sessions as the agent user. */
  opencode(): {
    command: string;
    spawn: ReturnType<typeof openCodeSpawnAsAgent>;
    sessionHomeRoot: string;
    supervisorWorkdirRoot: string;
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
  /** The server process: agent processes under it belong to running turns. */
  serverPid?: number;
  /** Where launch inputs wait for the shell that opens them: owner-only, the server's temp folder by default. */
  inputDir?: string;
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
  const codexHomeRoot = join(stateDir, 'codex-home');
  // The Factory chat's empty working folders: the CLI starts in them, so the agent must reach them.
  const claudeSupervisorRoot = join(stateDir, 'claude-code-supervisor');
  const codexSupervisorRoot = join(stateDir, 'codex-supervisor');
  const openCodeHomeRoot = join(stateDir, 'opencode-home');
  const openCodeSupervisorRoot = join(stateDir, 'opencode-supervisor');
  for (const dir of [stateDir, claudeConfigRoot, tempDir, codexHomeRoot, claudeSupervisorRoot, codexSupervisorRoot, openCodeHomeRoot, openCodeSupervisorRoot]) {
    mkdir(dir);
  }
  // Mastra runs command lines: they reach the agent as a program that reads its environment from a
  // private file on a descriptor (the same launch as a spawned CLI's).
  const bridge = new ShellCommandBridge(createAgentUserLauncher(config), new PrivateFileStash(options.inputDir ?? join(tmpdir(), 'factory-agent-inputs')));
  const reapSetting = env.FACTORY_AGENT_REAP?.trim().toLowerCase() || 'on';
  if (reapSetting !== 'on' && reapSetting !== 'off') throw new Error(`FACTORY_AGENT_REAP must be on or off, got ${JSON.stringify(env.FACTORY_AGENT_REAP)}.`);
  const reaper =
    reapSetting === 'off'
      ? undefined
      : new AgentReaper(new PsProcessTable(), new AgentUserSignaller(config.user), {
          agentUser: config.user,
          serverPid: options.serverPid ?? process.pid,
          // A Mastra turn has no process between two commands: what it started in the background keeps 10 minutes.
          idleGraceSeconds: 10 * 60,
          maxAgeSeconds: 6 * 3600,
          systemPrefixes: MACOS_SYSTEM_PREFIXES,
        });
  return {
    config,
    spawner,
    stateDir,
    reaper,
    processes: {
      shellProgram: (command, commandEnv) => bridge.commandLine(command, commandEnv),
      spawn: (command, args, { cwd, env: commandEnv }) => spawner.spawn({ command, args, env: commandEnv }, { cwd }),
    },
    claudeCode: () => ({
      // The agent's own `claude` on its PATH: a configured FACTORY_CLAUDE_CODE_COMMAND points into the
      // server user's home, which the agent can neither read nor run.
      command: env.FACTORY_AGENT_CLAUDE_COMMAND?.trim() || 'claude',
      spawn: claudeSpawnAsAgent(spawner),
      sessionConfigRoot: claudeConfigRoot,
      supervisorWorkdirRoot: claudeSupervisorRoot,
      tempDir,
      // On the agent's PATH (its own Node, `<home>/.local/node/bin`): the server's is in a home it cannot read.
      gateNode: 'node',
    }),
    codex: () => ({
      // The agent's own `codex` (agent-tools copies nvm's Node with its global packages).
      command: env.FACTORY_AGENT_CODEX_COMMAND?.trim() || 'codex',
      spawn: codexSpawnAsAgent(spawner),
      // Each session's CODEX_HOME (its thread history): the CLI writes there as the agent.
      sessionHomeRoot: codexHomeRoot,
      supervisorWorkdirRoot: codexSupervisorRoot,
    }),
    opencode: () => ({
      // The agent's own `opencode` (agent-tools copies it, as it does `claude` and `codex`).
      command: env.FACTORY_AGENT_OPENCODE_COMMAND?.trim() || 'opencode',
      spawn: openCodeSpawnAsAgent(spawner),
      // Each session's OpenCode state (its database): the CLI writes there as the agent.
      sessionHomeRoot: openCodeHomeRoot,
      supervisorWorkdirRoot: openCodeSupervisorRoot,
    }),
  };
}
