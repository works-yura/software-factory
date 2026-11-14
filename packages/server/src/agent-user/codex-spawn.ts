/**
 * Codex runs as the agent user (ADR-0041): the harness's injectable spawn, backed by
 * `@factory/agent-user`. Without the Seatbelt profile: Codex puts the commands it runs into a
 * Seatbelt sandbox of its own (its sandbox policy), and macOS cannot start one sandbox inside
 * another (`sandbox_apply: Operation not permitted`). The boundary for the CLI itself is the user.
 */

import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import type { ProcessSpawner } from '@factory/agent-user';
import type { CodexSpawn } from '@factory/harness-codex';

export function codexSpawnAsAgent(spawner: ProcessSpawner): CodexSpawn {
  return (command, args, options) =>
    spawner.spawn(
      { command, args, env: (options.env ?? {}) as Record<string, string | undefined>, seatbelt: false },
      { cwd: String(options.cwd ?? '/') },
    ) as unknown as ChildProcessWithoutNullStreams;
}
