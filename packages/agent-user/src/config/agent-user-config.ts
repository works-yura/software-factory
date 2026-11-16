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
  /** Folders put first on the agent's PATH: its own node, claude, codex, then this machine's toolchains. */
  readonly toolPath: readonly string[];
  /**
   * This machine's toolchain variables, as the server has them (`ANDROID_HOME`, `JAVA_HOME`, …):
   * every agent command gets them, so the agent finds the installed SDKs the way the owner's shell does.
   */
  readonly toolchainEnv?: Readonly<Record<string, string>>;
  /** Folders the agent may read but not write (the toolchains above): the Seatbelt profile allows them. */
  readonly readableRoots?: readonly string[];
  /**
   * Whether agent commands run under the Seatbelt profile when nothing more specific decides (the
   * launcher's `seatbeltFor`: a Factory's sandbox setting). `true` unless set.
   */
  readonly seatbelt?: boolean;
  /** The root-owned xcconfig `xcodebuild` applies under Seatbelt (`XCODE_XCCONFIG_FILE`). */
  readonly xcodeConfigPath?: string;
}

export class AgentUserConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentUserConfigError';
  }
}
