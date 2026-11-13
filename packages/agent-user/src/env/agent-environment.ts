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
