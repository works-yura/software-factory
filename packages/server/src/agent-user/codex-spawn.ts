/**
 * Codex runs as the agent user (ADR-0041): the harness's injectable spawn, backed by
 * `@factory/agent-user`. Under the Seatbelt profile when its Factory's isolation says so (ADR-0050),
 * as Claude Code and OpenCode are; macOS cannot start one Seatbelt sandbox inside another, so the
 * session then asks Codex for no sandbox of its own (`hostSandboxed`, the same `seatbeltAt` answer
 * for the same folder). With isolation `user`, Codex keeps its own sandbox policy.
 */

import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import type { ProcessSpawner } from '@factory/agent-user';
import type { CodexSpawn } from '@factory/harness-codex';

export function codexSpawnAsAgent(spawner: ProcessSpawner, seatbeltAt: (folder: string) => boolean): CodexSpawn {
  return (command, args, options) => {
    const cwd = String(options.cwd ?? '/');
    return spawner.spawn(
      { command, args, env: (options.env ?? {}) as Record<string, string | undefined>, seatbelt: seatbeltAt(cwd), folder: cwd },
      { cwd },
    ) as unknown as ChildProcessWithoutNullStreams;
  };
}
