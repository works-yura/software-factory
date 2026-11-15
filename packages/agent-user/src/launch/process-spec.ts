/** One process to start: what a harness would have spawned as the server's user. */
export interface ProcessSpec {
  readonly command: string;
  readonly args: readonly string[];
  /** Its environment as the server would give it; a launcher may replace parts. */
  readonly env: Record<string, string | undefined>;
  /**
   * Whether it runs under the Seatbelt profile. `false` for a tool that starts its own sandbox
   * (Codex): macOS cannot nest them. Left out, the launcher decides (`AgentUserLauncherOptions.seatbeltFor`).
   */
  readonly seatbelt?: boolean;
  /** The folder it works in (its cwd, or the card folder a shell command line belongs to): what the Seatbelt choice is made for. */
  readonly folder?: string;
}
