/** Which macOS user agents run as, and where it may work (ADR-0041). */
export interface AgentUserConfig {
  /** The macOS account agents run as: a standard user, never the server's own or root. */
  readonly user: string;
  /** Its home folder: its own tools, caches, simulators. */
  readonly home: string;
  /** The root-owned Seatbelt profile every agent command runs under. */
  readonly profilePath: string;
  /** Folders the agent may write besides its home and the temp folders: the card folders. */
  readonly writableRoots: readonly string[];
  /** Folders put first on the agent's PATH: its own node, claude, codex. */
  readonly toolPath: readonly string[];
  /**
   * Whether agent commands run under the Seatbelt profile (the default). `false` leaves the user as
   * the only boundary: what Xcode and SwiftPM need, since they start sandboxes of their own and macOS
   * cannot start one inside another.
   */
  readonly seatbelt?: boolean;
}

export class AgentUserConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentUserConfigError';
  }
}
