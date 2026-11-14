/**
 * Claude Code turns as the agent user (ADR-0041): the harness's injectable spawn, backed by
 * `@factory/agent-user`. The CLI gets the harness's environment (its allowlist, the turn's
 * credentials) with the agent user's identity, runs under the root-owned Seatbelt profile, and a
 * turn's stop reaches everything it started.
 */

import type { ProcessSpawner } from '@factory/agent-user';
import type { ClaudeChildProcess, ClaudeSpawn } from '@factory/harness-claude-code';

export function claudeSpawnAsAgent(spawner: ProcessSpawner): ClaudeSpawn {
  return (command, args, options) =>
    spawner.spawn({ command, args, env: options.env }, { cwd: options.cwd }) as unknown as ClaudeChildProcess;
}
