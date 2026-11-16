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
 * `FACTORY_AGENT_XCODE_CONFIG` (`/var/factory/agent-<user>.xcconfig`, what `xcodebuild` applies under Seatbelt),
 * `FACTORY_AGENT_TOOLCHAIN_ENV` (the server variables that locate this machine's toolchains, see
 * {@link agentToolchain}), `FACTORY_AGENT_READABLE` (more read-only folders, `:`-separated).
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
  const toolchain = agentToolchain(env);
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
    toolPath: [
      ...new Set([
        ...(toolPath.length > 0 ? toolPath : [`${home}/.local/bin`, `${home}/.local/node/bin`, `${home}/.local/fvm`, '/opt/homebrew/bin']),
        ...toolchain.path,
        ...userToolDirs(home),
      ]),
    ],
    seatbelt: true,
    xcodeConfigPath,
    toolchainEnv: toolchain.env,
    readableRoots: [...new Set([...toolchain.roots, ...parsePathList(env.FACTORY_AGENT_READABLE, 'FACTORY_AGENT_READABLE')])],
  };
}

/** The server variables that locate a toolchain, passed to agents when `FACTORY_AGENT_TOOLCHAIN_ENV` is unset. */
export const DEFAULT_AGENT_TOOLCHAIN_ENV = ['ANDROID_HOME', 'ANDROID_SDK_ROOT', 'JAVA_HOME'] as const;

/** Where a toolchain variable's commands are, as a developer's shell puts them on its PATH. Others add none. */
const TOOLCHAIN_BIN_DIRS: Readonly<Record<string, readonly string[]>> = {
  ANDROID_HOME: ['platform-tools', 'cmdline-tools/latest/bin', 'emulator'],
  ANDROID_SDK_ROOT: ['platform-tools', 'cmdline-tools/latest/bin', 'emulator'],
  JAVA_HOME: ['bin'],
};

/** Names an agent's toolchain variables must not take: who it is and where it looks for commands. */
const RESERVED = new Set(['HOME', 'USER', 'LOGNAME', 'SHELL', 'PATH', 'TMPDIR']);

export interface AgentToolchain {
  /** The variables, with the server's values: only those the server has. */
  env: Record<string, string>;
  /** Their command folders, for the agent's PATH. */
  path: string[];
  /** The folders they name: read-only for the agent (`2-system.sh agent-sdks` opens them, Seatbelt allows them). */
  roots: string[];
}

/**
 * This machine's toolchains as the server's environment names them (`apps/server/.env`): the
 * variables in `FACTORY_AGENT_TOOLCHAIN_ENV` (comma- or space-separated; {@link DEFAULT_AGENT_TOOLCHAIN_ENV}
 * when unset, `none` for none) that the server has, passed to every agent command with the same
 * value, their usual command folders put on its PATH. Factory picks no SDK or version: the agent
 * sees what the owner's shell sees and finds the rest itself (`fvm`, `.fvmrc`, `pubspec.yaml`).
 */
export function agentToolchain(env: Record<string, string | undefined>): AgentToolchain {
  const setting = env.FACTORY_AGENT_TOOLCHAIN_ENV?.trim();
  const names = !setting ? [...DEFAULT_AGENT_TOOLCHAIN_ENV] : setting === 'none' ? [] : setting.split(/[\s,]+/).filter(Boolean);
  const result: AgentToolchain = { env: {}, path: [], roots: [] };
  for (const name of names) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || RESERVED.has(name)) {
      throw new AgentUserConfigError(`FACTORY_AGENT_TOOLCHAIN_ENV: ${JSON.stringify(name)} cannot be passed to the agent.`);
    }
    const value = env[name]?.trim();
    if (!value) continue;
    result.env[name] = value;
    if (!value.startsWith('/')) continue;
    const [root] = parsePathList(value, name);
    if (!root) continue;
    result.roots.push(root);
    for (const dir of TOOLCHAIN_BIN_DIRS[name] ?? []) result.path.push(`${root}/${dir}`);
  }
  return { env: result.env, path: [...new Set(result.path)], roots: [...new Set(result.roots)] };
}

/**
 * Where the usual package managers put a user's command-line tools, always on the agent's PATH:
 * whatever a repository's setup command installs as the agent (`dart pub global activate
 * flutterfire_cli`, `cargo install`, `go install`, `npm install -g`) is found the next time, the
 * way it is on a developer's machine or in CI. Factory never lists a project's tools itself.
 */
export function userToolDirs(home: string): string[] {
  // fvm's global version (`fvm global <version>`, a `default` link in its cache), as on the owner's PATH.
  return [`${home}/fvm/default/bin`, `${home}/.pub-cache/bin`, `${home}/.cargo/bin`, `${home}/go/bin`, `${home}/.npm-global/bin`];
}
