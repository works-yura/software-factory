/**
 * How the agent's environment reaches it across `sudo` and `env -i`, which drop everything. A
 * transport adds what it needs to the command line (never the values) and says what to write where.
 */
export interface EnvTransport {
  /** Arguments that load the environment and then run the rest of the command line. */
  loaderArgs(): string[];
  /** What to write to {@link fd} of the spawned process before closing it. */
  payload(env: Record<string, string>): string;
  /** The extra descriptor the spawn opens as a pipe. */
  readonly fd: number;
}
