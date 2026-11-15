import type { AgentUserConfig } from '../config/agent-user-config.ts';
import { agentEnvironment, agentIdentity, xcodeUnderSeatbelt } from '../env/agent-environment.ts';
import type { EnvTransport } from '../env/env-transport.ts';
import { withGitTrust } from '../env/git-trust.ts';
import { PipeEnvTransport } from '../env/pipe-env-transport.ts';

import type { LaunchPlan } from './launch-plan.ts';
import type { ProcessLauncher } from './process-launcher.ts';
import type { ProcessSpec } from './process-spec.ts';
import { WrappingLauncher } from './wrapping-launcher.ts';
import { ClearEnvWrapper, EnvLoaderWrapper, SeatbeltWrapper, SudoWrapper } from './wrappers/index.ts';

/**
 * Whether one process runs under the Seatbelt profile, asked per launch with the folder it works in
 * (a Factory's sandbox setting, ADR-0047's settings page). `undefined` falls back to the
 * configuration's default.
 */
export type SeatbeltChoice = (spec: ProcessSpec) => boolean | undefined;

export interface AgentUserLauncherOptions {
  transport?: EnvTransport;
  seatbeltFor?: SeatbeltChoice;
}

/**
 * The launcher for an agent user (the shape of SandVault's `sv` launch):
 *
 *   sudo -n -C 4 -u <user> -- env -i HOME=… USER=… PATH=… sh -c <loader> factory-agent \
 *     sandbox-exec -f <profile> <command> <args…>        (environment on fd 3)
 *
 * Without `sandbox-exec` for a process the choice leaves outside it. Under it, Xcode and SwiftPM
 * are told not to start sandboxes of their own (`xcodeUnderSeatbelt`), as SandVault does.
 */
export function createAgentUserLauncher(config: AgentUserConfig, options: AgentUserLauncherOptions = {}): ProcessLauncher & { readonly layers: string[] } {
  const identity = agentIdentity(config);
  const inner = new WrappingLauncher(
    [
      new SudoWrapper(config.user),
      new ClearEnvWrapper({ HOME: identity.HOME, USER: identity.USER, PATH: identity.PATH }),
      new EnvLoaderWrapper(options.transport ?? new PipeEnvTransport()),
      new SeatbeltWrapper(config.profilePath),
    ],
    // Card folders are the server's clones: git as the agent must trust them.
    (env, spec) => {
      const own = withGitTrust(agentEnvironment(config, env), config.writableRoots);
      return spec.seatbelt === false ? own : { ...own, ...xcodeUnderSeatbelt(config) };
    },
  );
  return {
    get layers() {
      return inner.layers;
    },
    plan(spec: ProcessSpec): LaunchPlan {
      const seatbelt = spec.seatbelt === false ? false : (options.seatbeltFor?.(spec) ?? config.seatbelt !== false);
      return inner.plan({ ...spec, seatbelt });
    },
  };
}
