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

  /** The sudo arguments for `kill -s <signal> -- -<group>` as the agent user. */
  killArgs(target: string, signal: NodeJS.Signals): string[] {
    return ['-n', '-u', this.user, '--', SYSTEM_BINARIES.kill, '-s', signal.replace(/^SIG/, ''), '--', target];
  }

  async signalGroup(processGroup: number, signal: NodeJS.Signals): Promise<void> {
    assertProcessGroup(processGroup);
    await this.runner.run(SYSTEM_BINARIES.sudo, this.killArgs(`-${processGroup}`, signal));
  }

  /** Every process of the agent user: for a server shutting down or a person stopping all agents. */
  async signalAll(signal: NodeJS.Signals = 'SIGKILL'): Promise<void> {
    await this.runner.run(SYSTEM_BINARIES.sudo, this.killArgs('-1', signal));
  }
}
