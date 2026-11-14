/**
 * OpenCode runs as the agent user (ADR-0041): the harness's injectable spawn, backed by
 * `@factory/agent-user`. Under the root-owned Seatbelt profile, as Claude Code is: OpenCode runs
 * the commands it is allowed with no sandbox of its own, so the profile is what bounds them. Its
 * server listens on a loopback port the Factory server connects to (the profile denies the agent
 * only the Factory's own ports, not listening).
 */

import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import type { ProcessSpawner } from '@factory/agent-user';
import type { OpenCodeSpawn } from '@factory/harness-opencode';

export function openCodeSpawnAsAgent(spawner: ProcessSpawner): OpenCodeSpawn {
  return (command, args, options) =>
    spawner.spawn(
      { command, args, env: (options.env ?? {}) as Record<string, string | undefined> },
      { cwd: String(options.cwd ?? '/') },
    ) as unknown as ChildProcessWithoutNullStreams;
}
