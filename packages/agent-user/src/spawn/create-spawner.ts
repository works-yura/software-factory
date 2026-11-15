import type { AgentUserConfig } from '../config/agent-user-config.ts';
import { createAgentUserLauncher, type SeatbeltChoice } from '../launch/agent-user-launcher.ts';
import { SameUserLauncher } from '../launch/same-user-launcher.ts';
import { AgentUserSignaller } from '../signal/agent-user-signaller.ts';
import { CompositeSignaller } from '../signal/composite-signaller.ts';
import { ServerSignaller } from '../signal/server-signaller.ts';
import type { CommandRunner } from '../system/command-runner.ts';

import { LaunchingSpawner, type SpawnFunction } from './launching-spawner.ts';

/**
 * The spawner for this server (Factory Method): as the agent user when one is configured, else as
 * the server itself, same interface either way.
 */
export function createProcessSpawner(
  config: AgentUserConfig | undefined,
  overrides: { spawn?: SpawnFunction; runner?: CommandRunner; seatbeltFor?: SeatbeltChoice } = {},
): LaunchingSpawner {
  if (!config) return new LaunchingSpawner(new SameUserLauncher(), new ServerSignaller(), overrides.spawn);
  return new LaunchingSpawner(
    createAgentUserLauncher(config, overrides.seatbeltFor ? { seatbeltFor: overrides.seatbeltFor } : {}),
    new CompositeSignaller([new ServerSignaller(), new AgentUserSignaller(config.user, overrides.runner)]),
    overrides.spawn,
  );
}
