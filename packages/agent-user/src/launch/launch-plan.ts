/** Data written to an extra descriptor of the spawned process, then closed. */
export interface LaunchInput {
  readonly fd: number;
  readonly payload: string;
}

/**
 * What to spawn, built from the inside out: the program and its arguments, the environment the
 * spawned process gets, and data for extra descriptors. Holds no secret on `argv`.
 */
export interface LaunchPlan {
  readonly argv: readonly [string, ...string[]];
  readonly env: Readonly<Record<string, string>>;
  readonly inputs: readonly LaunchInput[];
  /** Whether the process runs as another user, so the server cannot signal all of it itself. */
  readonly crossesUser: boolean;
}

export function planOf(command: string, args: readonly string[], env: Record<string, string>): LaunchPlan {
  if (!command) throw new Error('No command to run.');
  return { argv: [command, ...args], env, inputs: [], crossesUser: false };
}
