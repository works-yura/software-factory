/** Sends a signal to a process group (its leader's pid). Never throws for a group that is gone. */
export interface ProcessSignaller {
  signalGroup(processGroup: number, signal: NodeJS.Signals): Promise<void>;
}

/** Groups 0 and 1 mean "everything of mine" and init; a caller never means them. */
export function assertProcessGroup(processGroup: number): void {
  if (!Number.isInteger(processGroup) || processGroup <= 1) throw new RangeError(`${processGroup} is not a process group to signal.`);
}
