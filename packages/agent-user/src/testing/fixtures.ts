import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import type { AgentUserConfig } from '../config/agent-user-config.ts';
import type { CommandRunner } from '../system/command-runner.ts';

export const agentConfig: AgentUserConfig = {
  user: 'factory',
  home: '/Users/factory',
  profilePath: '/var/factory/agent-factory.sb',
  writableRoots: ['/Volumes/dot/Project/factory/sandboxes'],
  toolPath: ['/Users/factory/.local/bin'],
};

/** A value with every character a shell or a quoting bug trips on. */
export const nastyValue = `sk-'single' "double" $HOME $(id) \`id\` \\ ; | & * ? [x] ~ # !\n\tnext line ünïcödé`;

/** Records the commands it is asked to run; succeeds. */
export class RecordingRunner implements CommandRunner {
  readonly calls: string[][] = [];

  async run(command: string, args: readonly string[]) {
    this.calls.push([command, ...args]);
    return { code: 0, stderr: '' };
  }
}

/** A spawn that records what it was given and exposes what was written to each pipe. */
export function fakeSpawn(pid = 4242) {
  const calls: { command: string; args: readonly string[]; options: Record<string, unknown> }[] = [];
  const written: Record<number, string> = {};
  const spawn = (command: string, args: readonly string[], options: Record<string, unknown>) => {
    calls.push({ command, args, options });
    const stdio = (options.stdio as unknown[]).map((_, fd) => {
      const pipe = new PassThrough();
      pipe.on('data', chunk => (written[fd] = (written[fd] ?? '') + String(chunk)));
      return pipe;
    });
    let killedWith: unknown;
    const child = Object.assign(new EventEmitter(), {
      pid,
      exitCode: null as number | null,
      signalCode: null as string | null,
      stdio,
      kill: (signal?: unknown) => {
        killedWith = signal;
        return true;
      },
      killedWith: () => killedWith,
    });
    return child;
  };
  return { spawn: spawn as never, calls, written };
}
