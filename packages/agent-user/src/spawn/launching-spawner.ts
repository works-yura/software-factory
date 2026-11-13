import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import type { Writable } from 'node:stream';

import type { ProcessLauncher } from '../launch/process-launcher.ts';
import type { ProcessSpec } from '../launch/process-spec.ts';
import type { ProcessSignaller } from '../signal/process-signaller.ts';

import type { ProcessSpawner } from './process-spawner.ts';

export type SpawnFunction = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

/**
 * Spawns what a {@link ProcessLauncher} plans: detached (its own group, id = its pid), stdin, stdout
 * and stderr piped, each planned input written to its descriptor and closed. `kill` goes to the
 * {@link ProcessSignaller} for the whole group while the process runs.
 */
export class LaunchingSpawner implements ProcessSpawner {
  private readonly launcher: ProcessLauncher;
  private readonly signaller: ProcessSignaller;
  private readonly spawnFn: SpawnFunction;

  constructor(launcher: ProcessLauncher, signaller: ProcessSignaller, spawnFn: SpawnFunction = nodeSpawn as SpawnFunction) {
    this.launcher = launcher;
    this.signaller = signaller;
    this.spawnFn = spawnFn;
  }

  spawn(spec: ProcessSpec, { cwd }: { cwd: string }): ChildProcess {
    const plan = this.launcher.plan(spec);
    const extra = plan.inputs.length ? Math.max(...plan.inputs.map(input => input.fd)) - 2 : 0;
    const stdio = Array.from({ length: 3 + extra }, () => 'pipe' as const);
    const [command, ...args] = plan.argv;
    const child = this.spawnFn(command, args, { cwd, env: { ...plan.env }, detached: true, stdio });
    for (const input of plan.inputs) {
      const pipe = child.stdio[input.fd] as Writable | null | undefined;
      if (!pipe) continue;
      pipe.on('error', () => {
        // The process died before reading it; its exit says why.
      });
      pipe.end(input.payload);
    }
    this.#routeKill(child);
    return child;
  }

  #routeKill(child: ChildProcess): void {
    const own = child.kill.bind(child);
    child.kill = (signal: NodeJS.Signals | number = 'SIGTERM') => {
      const running = child.pid !== undefined && child.exitCode === null && child.signalCode === null;
      if (!running) return own(signal);
      void this.signaller.signalGroup(child.pid as number, typeof signal === 'number' ? 'SIGTERM' : signal);
      return true;
    };
  }
}
