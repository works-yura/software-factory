import { isAccountName } from './account-name.ts';
import { AgentUserConfigError, type AgentUserConfig } from './agent-user-config.ts';
import { parsePathList } from './path-list.ts';

export interface AgentUserEnvContext {
  /** The user the server runs as: agents must not run as it. */
  serverUser: string;
  /** Where card folders are made (`MASTRACODE_LOCAL_SANDBOX_ROOT`). */
  sandboxRoot: string;
}

/**
 * The agent user the server's environment names, or `undefined` when agents run as the server's own
 * user (the default). Throws on a configuration that would look protected and is not: a bad name,
 * the server's own user, root, or no folder to work in.
 *
 * `FACTORY_AGENT_USER` (required to turn it on), `FACTORY_AGENT_HOME` (`/Users/<user>`),
 * `FACTORY_AGENT_PROFILE` (`/var/factory/agent-<user>.sb`), `FACTORY_AGENT_WRITABLE` (more writable
 * folders, `:`-separated), `FACTORY_AGENT_PATH` (its tools; `<home>/.local/bin:<home>/.local/node/bin:<home>/.local/fvm:/opt/homebrew/bin`:
 * its own claude, node, codex and fvm (`2-system.sh agent-tools`, `agent-mobile-tools`), then Homebrew's CocoaPods and gh),
 * `FACTORY_AGENT_XCODE_CONFIG` (`/var/factory/agent-<user>.xcconfig`, what `xcodebuild` applies under Seatbelt).
 * Whether Seatbelt applies is a Factory setting, not an environment variable.
 */
export function agentUserFromEnv(env: Record<string, string | undefined>, context: AgentUserEnvContext): AgentUserConfig | undefined {
  const user = env.FACTORY_AGENT_USER?.trim();
  if (!user) return undefined;
  if (!isAccountName(user)) throw new AgentUserConfigError(`FACTORY_AGENT_USER: ${JSON.stringify(user)} is not a valid account name.`);
  if (user === 'root' || user === context.serverUser) {
    throw new AgentUserConfigError(`FACTORY_AGENT_USER must be a separate standard user, not ${JSON.stringify(user)}.`);
  }
  const home = parsePathList(env.FACTORY_AGENT_HOME, 'FACTORY_AGENT_HOME')[0] ?? `/Users/${user}`;
  const profilePath = parsePathList(env.FACTORY_AGENT_PROFILE, 'FACTORY_AGENT_PROFILE')[0] ?? `/var/factory/agent-${user}.sb`;
  const writableRoots = [
    ...parsePathList(context.sandboxRoot, 'MASTRACODE_LOCAL_SANDBOX_ROOT'),
    ...parsePathList(env.FACTORY_AGENT_WRITABLE, 'FACTORY_AGENT_WRITABLE'),
  ];
  if (writableRoots.length === 0) throw new AgentUserConfigError('The agent user needs a folder to work in (MASTRACODE_LOCAL_SANDBOX_ROOT).');
  const toolPath = parsePathList(env.FACTORY_AGENT_PATH, 'FACTORY_AGENT_PATH');
  if (env.FACTORY_AGENT_SEATBELT !== undefined) {
    throw new AgentUserConfigError(
      'FACTORY_AGENT_SEATBELT was removed: the Seatbelt profile is a Factory setting (Settings › Environment › Sandbox › Agent isolation). Remove it from the environment.',
    );
  }
  const xcodeConfigPath = parsePathList(env.FACTORY_AGENT_XCODE_CONFIG, 'FACTORY_AGENT_XCODE_CONFIG')[0] ?? `/var/factory/agent-${user}.xcconfig`;
  return {
    user,
    home,
    profilePath,
    writableRoots: [...new Set(writableRoots)],
    toolPath: toolPath.length > 0 ? toolPath : [`${home}/.local/bin`, `${home}/.local/node/bin`, `${home}/.local/fvm`, '/opt/homebrew/bin'],
    seatbelt: true,
    xcodeConfigPath,
  };
}
