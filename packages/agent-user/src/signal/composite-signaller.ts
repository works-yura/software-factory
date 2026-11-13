import type { ProcessSignaller } from './process-signaller.ts';

/** Several signallers, all of them, in order (Composite): e.g. as the server and as the agent user. */
export class CompositeSignaller implements ProcessSignaller {
  private readonly signallers: readonly ProcessSignaller[];

  constructor(signallers: readonly ProcessSignaller[]) {
    this.signallers = signallers;
  }

  async signalGroup(processGroup: number, signal: NodeJS.Signals): Promise<void> {
    for (const signaller of this.signallers) await signaller.signalGroup(processGroup, signal);
  }
}
