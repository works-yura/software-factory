/** One process to start: what a harness would have spawned as the server's user. */
export interface ProcessSpec {
  readonly command: string;
  readonly args: readonly string[];
  /** Its environment as the server would give it; a launcher may replace parts. */
  readonly env: Record<string, string | undefined>;
  /** `false` for tools that run their own sandbox (`xcodebuild`, `swift`): macOS cannot nest them. */
  readonly seatbelt?: boolean;
}
