import type { AgentUserConfig } from '../config/agent-user-config.ts';
import { SYSTEM_PATH } from '../system/paths.ts';

import { assertEnvName, assertEnvValue } from './env-name.ts';

/** Variables that describe who runs the process: always the agent user's, never the server's. */
export const IDENTITY_KEYS = ['HOME', 'USER', 'LOGNAME', 'SHELL', 'PATH', 'TMPDIR'] as const;
const IDENTITY = new Set<string>(IDENTITY_KEYS);

/** The agent user's identity variables. */
export function agentIdentity(config: AgentUserConfig): Record<(typeof IDENTITY_KEYS)[number], string> {
  return {
    HOME: config.home,
    USER: config.user,
    LOGNAME: config.user,
    SHELL: '/bin/zsh',
    PATH: [...config.toolPath, ...SYSTEM_PATH].join(':'),
    TMPDIR: `${config.home}/.tmp/`,
  };
}

/**
 * The agent's whole environment: what the caller passes (the harness's allowlist, the turn's
 * credentials) minus the server's identity, plus the agent user's. Unset values are dropped; names
 * and values a shell could misread are refused.
 */
export function agentEnvironment(config: AgentUserConfig, env: Record<string, string | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || IDENTITY.has(name)) continue;
    assertEnvName(name);
    assertEnvValue(name, value);
    result[name] = value;
  }
  return { ...result, ...agentIdentity(config) };
}

/**
 * What Xcode and SwiftPM need under the Seatbelt profile (SandVault's "Sandboxing xcodebuild and
 * swift"): they start sandboxes of their own for package manifests, plugins and macros, and macOS
 * refuses one inside another (`sandbox_apply: Operation not permitted`). SwiftPM reads the two
 * variables; `xcodebuild` applies the root-owned xcconfig (`OTHER_SWIFT_FLAGS = $(inherited)
 * -disable-sandbox`) to every build, and its package sandbox is off in the agent's Xcode defaults
 * (`2-system.sh agent-xcode`). Our profile is then the sandbox they run in.
 */
export function xcodeUnderSeatbelt(config: AgentUserConfig): Record<string, string> {
  return {
    SWIFTPM_DISABLE_SANDBOX: '1',
    SWIFT_BUILD_USE_SANDBOX: '0',
    ...(config.xcodeConfigPath ? { XCODE_XCCONFIG_FILE: config.xcodeConfigPath } : {}),
  };
}
