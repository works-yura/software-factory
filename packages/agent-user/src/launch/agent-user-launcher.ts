import type { AgentUserConfig } from '../config/agent-user-config.ts';
import { agentEnvironment, agentIdentity } from '../env/agent-environment.ts';
import type { EnvTransport } from '../env/env-transport.ts';
import { PipeEnvTransport } from '../env/pipe-env-transport.ts';

import { WrappingLauncher } from './wrapping-launcher.ts';
import { ClearEnvWrapper, EnvLoaderWrapper, SeatbeltWrapper, SudoWrapper } from './wrappers/index.ts';

export interface AgentUserLauncherOptions {
  transport?: EnvTransport;
}

/**
 * The launcher for an agent user (the shape of SandVault's `sv` launch):
 *
 *   sudo -n -C 4 -u <user> -- env -i HOME=… USER=… PATH=… sh -c <loader> factory-agent \
 *     sandbox-exec -f <profile> <command> <args…>        (environment on fd 3)
 */
export function createAgentUserLauncher(config: AgentUserConfig, options: AgentUserLauncherOptions = {}): WrappingLauncher {
  const identity = agentIdentity(config);
  return new WrappingLauncher(
    [
      new SudoWrapper(config.user),
      new ClearEnvWrapper({ HOME: identity.HOME, USER: identity.USER, PATH: identity.PATH }),
      new EnvLoaderWrapper(options.transport ?? new PipeEnvTransport()),
      new SeatbeltWrapper(config.profilePath),
    ],
    env => agentEnvironment(config, env),
  );
}
