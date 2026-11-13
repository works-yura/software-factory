/**
 * Which macOS user agents run as, and where it may write. Off unless `FACTORY_AGENT_USER` names the
 * user: then every agent process the server starts runs as that user (ADR-0041).
 */

import { isAbsolute, normalize } from 'node:path';

export interface AgentUserConfig {
  /** The macOS account agents run as: a standard user, never the server's own or root. */
  readonly user: string;
  /** Its home folder: its own tools, caches, simulators. */
  readonly home: string;
  /**
   * The Seatbelt profile every agent command runs under: root-owned and outside the agent's reach,
   * so the agent cannot loosen it (`scripts/mac-mini/isolation/2-system.sh agent-profile`).
   */
  readonly profilePath: string;
  /** Folders the agent may write besides its home and the temp folders: the card folders. */
  readonly writableRoots: readonly string[];
  /** Folders put first on the agent's PATH: its own node, claude, codex. */
  readonly toolPath: readonly string[];
}

/** Account names macOS accepts and a shell or sudoers line cannot misread. */
const USER_NAME = /^[a-z_][a-z0-9_-]{0,31}$/;

/** The PATH every agent command ends with. */
export const SYSTEM_PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'] as const;

export class AgentUserConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentUserConfigError';
  }
}

function absolutePaths(value: string | undefined, name: string): string[] {
  if (!value?.trim()) return [];
  return value
    .split(':')
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => {
      if (!isAbsolute(part)) throw new AgentUserConfigError(`${name}: ${JSON.stringify(part)} is not an absolute path.`);
      return normalize(part).replace(/\/+$/, '') || '/';
    });
}

/**
 * The agent user the server's environment names, or `undefined` when agents run as the server's own
 * user (the default). Throws on a configuration that would run agents unprotected while looking
 * protected: a bad name, the server's own user, root, or no folder to work in.
 */
export function agentUserFromEnv(
  env: Record<string, string | undefined>,
  { serverUser, sandboxRoot }: { serverUser: string; sandboxRoot: string },
): AgentUserConfig | undefined {
  const user = env.FACTORY_AGENT_USER?.trim();
  if (!user) return undefined;
  if (!USER_NAME.test(user)) throw new AgentUserConfigError(`FACTORY_AGENT_USER: ${JSON.stringify(user)} is not a valid account name.`);
  if (user === 'root' || user === serverUser) {
    throw new AgentUserConfigError(`FACTORY_AGENT_USER must be a separate standard user, not ${JSON.stringify(user)}.`);
  }
  const home = absolutePaths(env.FACTORY_AGENT_HOME, 'FACTORY_AGENT_HOME')[0] ?? `/Users/${user}`;
  const profilePath = absolutePaths(env.FACTORY_AGENT_PROFILE, 'FACTORY_AGENT_PROFILE')[0] ?? `/var/factory/agent-${user}.sb`;
  const writableRoots = [...absolutePaths(sandboxRoot, 'MASTRACODE_LOCAL_SANDBOX_ROOT'), ...absolutePaths(env.FACTORY_AGENT_WRITABLE, 'FACTORY_AGENT_WRITABLE')];
  if (writableRoots.length === 0) throw new AgentUserConfigError('The agent user needs a folder to work in (MASTRACODE_LOCAL_SANDBOX_ROOT).');
  const toolPath = absolutePaths(env.FACTORY_AGENT_PATH, 'FACTORY_AGENT_PATH');
  return {
    user,
    home,
    profilePath,
    writableRoots: [...new Set(writableRoots)],
    toolPath: toolPath.length > 0 ? toolPath : [`${home}/.local/bin`, `${home}/.local/node/bin`],
  };
}
