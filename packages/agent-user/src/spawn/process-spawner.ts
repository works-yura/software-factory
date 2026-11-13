import type { ChildProcess } from 'node:child_process';

import type { ProcessSpec } from '../launch/process-spec.ts';

/**
 * Starts a process with piped stdio in its own process group; its `kill` stops the whole group,
 * whoever it runs as. Shaped so harnesses that accept an injected spawn can use it.
 */
export interface ProcessSpawner {
  spawn(spec: ProcessSpec, options: { cwd: string }): ChildProcess;
}
