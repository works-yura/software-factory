import { assertProcessGroup, type ProcessSignaller } from './process-signaller.ts';

export type KillFunction = (pid: number, signal: NodeJS.Signals) => void;

/**
 * Signals the group as the server. For an agent user's group this reaches only sudo (whose real
 * uid is the server's), which passes the signal on to its command.
 */
export class ServerSignaller implements ProcessSignaller {
  private readonly kill: KillFunction;

  constructor(kill: KillFunction = (pid, signal) => process.kill(pid, signal)) {
    this.kill = kill;
  }

  async signalGroup(processGroup: number, signal: NodeJS.Signals): Promise<void> {
    assertProcessGroup(processGroup);
    try {
      this.kill(-processGroup, signal);
    } catch {
      // Gone, or only another user's processes are left in it.
    }
  }
}
