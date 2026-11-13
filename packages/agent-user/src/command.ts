/**
 * The command line that runs one agent process as the agent user, the way SandVault's `sv` starts a
 * session (`sudo --user=<sandbox user> /usr/bin/env -i … sandbox-exec -f <profile> …`), adapted for a
 * server that starts it programmatically:
 *
 *   /usr/bin/sudo -n -C 4 -u <user> -- /usr/bin/env -i HOME=… USER=… PATH=… \
 *     /bin/sh -c '<read the environment from fd 3>' factory-agent \
 *     /usr/bin/sandbox-exec -f <profile> <command> <args…>
 *
 * - `sudo -n` never asks for a password: without the sudoers rule the start fails at once.
 * - `env -i` drops the server's environment; only what is listed reaches the agent.
 * - Secrets never go on a command line, which every local user can read (`ps`): the environment
 *   travels through a pipe on fd 3 (`-C 4` keeps it open across sudo; the sudoers rule allows
 *   `closefrom_override`) and a tiny `sh` loader exports it before exec.
 * - The Seatbelt profile is root-owned (see `profile.ts`); `seatbelt: false` leaves it out for
 *   tools that run their own sandbox, which macOS cannot nest (`xcodebuild`, `swift`).
 * - The working directory is inherited: sudo keeps it unless asked to change it.
 */

import { SYSTEM_PATH, type AgentUserConfig } from './config.ts';

export const SUDO = '/usr/bin/sudo';
export const ENV = '/usr/bin/env';
export const SH = '/bin/sh';
export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
/** The descriptor the environment is written to; sudo is told to keep 0–3 open. */
export const ENV_FD = 3;

/** The process name the loader shows as `$0`. */
const LOADER_NAME = 'factory-agent';

/**
 * Reads `export K='v'` lines from fd 3 and runs the rest of the arguments. `eval` sees only what
 * {@link encodeAgentEnv} wrote: names checked, values single-quoted.
 */
export const ENV_LOADER = `eval "$(/bin/cat <&${ENV_FD})" && exec ${ENV_FD}<&- && exec "$@"`;

/** Variables the agent's environment always has, set from the agent user, never from the server. */
const OWN_KEYS = new Set(['HOME', 'USER', 'LOGNAME', 'SHELL', 'PATH', 'TMPDIR']);
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class AgentCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentCommandError';
  }
}

export interface AgentProcessSpec {
  command: string;
  args: readonly string[];
  /** What the process would have had as the server's user; HOME, USER, PATH… are replaced. */
  env: Record<string, string | undefined>;
  /** `false` for tools that sandbox themselves (`xcodebuild`, `swift`): macOS cannot nest sandboxes. */
  seatbelt?: boolean;
}

export interface AgentLaunch {
  /** What to spawn: sudo and its arguments. Holds no secret. */
  command: string;
  args: string[];
  /** sudo's own environment: nothing of the server's. */
  env: Record<string, string>;
  /** Write this to fd {@link ENV_FD} of the spawned process, then close it. */
  envPayload: string;
  /** The extra descriptor the spawn must open as a pipe. */
  envFd: typeof ENV_FD;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The agent's whole environment: the caller's, with the agent user's own identity and PATH. */
export function agentEnv(config: AgentUserConfig, env: Record<string, string | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || OWN_KEYS.has(key)) continue;
    if (!ENV_NAME.test(key)) throw new AgentCommandError(`Environment variable name ${JSON.stringify(key)} is not allowed.`);
    if (value.includes('\0')) throw new AgentCommandError(`Environment variable ${key} holds a NUL byte.`);
    result[key] = value;
  }
  return {
    ...result,
    HOME: config.home,
    USER: config.user,
    LOGNAME: config.user,
    SHELL: '/bin/zsh',
    PATH: [...config.toolPath, ...SYSTEM_PATH].join(':'),
    TMPDIR: `${config.home}/.tmp/`,
  };
}

/** `export K='v'` lines for {@link ENV_LOADER}. */
export function encodeAgentEnv(env: Record<string, string>): string {
  return Object.entries(env)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `export ${key}=${shellQuote(value)}`)
    .join('\n');
}

/** How to start one agent process as the agent user. */
export function agentLaunch(config: AgentUserConfig, spec: AgentProcessSpec): AgentLaunch {
  if (!spec.command) throw new AgentCommandError('No command to run.');
  const env = agentEnv(config, spec.env);
  const seatbelt = spec.seatbelt ?? true;
  return {
    command: SUDO,
    args: [
      '-n',
      '-C',
      String(ENV_FD + 1),
      '-u',
      config.user,
      '--',
      ENV,
      '-i',
      // Only what the loader needs to start; the rest comes through fd 3.
      `HOME=${env.HOME}`,
      `USER=${env.USER}`,
      `PATH=${env.PATH}`,
      SH,
      '-c',
      ENV_LOADER,
      LOADER_NAME,
      ...(seatbelt ? [SANDBOX_EXEC, '-f', config.profilePath] : []),
      spec.command,
      ...spec.args,
    ],
    env: { PATH: SYSTEM_PATH.join(':') },
    envPayload: `${encodeAgentEnv(env)}\n`,
    envFd: ENV_FD,
  };
}
