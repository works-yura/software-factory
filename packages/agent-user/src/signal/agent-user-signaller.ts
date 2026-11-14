import { ExecFileRunner, type CommandRunner } from '../system/command-runner.ts';
import { SYSTEM_BINARIES } from '../system/paths.ts';

import { assertProcessGroup, type ProcessSignaller } from './process-signaller.ts';

/** Signals as the agent user through sudo: reaches everything the agent started in the group. */
export class AgentUserSignaller implements ProcessSignaller {
  private readonly user: string;
  private readonly runner: CommandRunner;

  constructor(user: string, runner: CommandRunner = new ExecFileRunner()) {
    this.user = user;
    this.runner = runner;
  }

  /** The sudo arguments for `kill -s <signal> -- <targets>` as the agent user. */
  killArgs(target: string | readonly string[], signal: NodeJS.Signals): string[] {
    return ['-n', '-u', this.user, '--', SYSTEM_BINARIES.kill, '-s', signal.replace(/^SIG/, ''), '--', ...[target].flat()];
  }

  async signalGroup(processGroup: number, signal: NodeJS.Signals): Promise<void> {
    assertProcessGroup(processGroup);
    await this.runner.run(SYSTEM_BINARIES.sudo, this.killArgs(`-${processGroup}`, signal));
  }

  /** Single processes (never a group, 0 or 1): ones the agent left behind. */
  async signalProcesses(pids: readonly number[], signal: NodeJS.Signals): Promise<void> {
    for (const pid of pids) if (!Number.isInteger(pid) || pid <= 1) throw new RangeError(`${pid} is not a process to signal.`);
    if (pids.length > 0) await this.runner.run(SYSTEM_BINARIES.sudo, this.killArgs(pids.map(String), signal));
  }

  /** Every process of the agent user: for a server shutting down or a person stopping all agents. */
  async signalAll(signal: NodeJS.Signals = 'SIGKILL'): Promise<void> {
    await this.runner.run(SYSTEM_BINARIES.sudo, this.killArgs('-1', signal));
  }
}
