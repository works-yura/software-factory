import { SYSTEM_BINARIES } from '../system/paths.ts';

import type { EnvTransport } from './env-transport.ts';
import { assertEnvName } from './env-name.ts';
import { shellQuote } from './shell-quote.ts';

/**
 * The environment as `export NAME='value'` lines on a pipe (fd 3 by default), read by a tiny `sh`
 * loader that exports them, closes the pipe and execs the rest of its arguments. Values never reach
 * a command line, which every local user can read with `ps`. `eval` only ever sees what
 * {@link payload} wrote: names checked, values single-quoted.
 */
/** A shell variable (not exported) the payload sets last. */
const MARKER = '__factory_agent_env_complete';

/** The exit code of a loader that got no complete environment. */
export const LOADER_FAILED = 125;

export class PipeEnvTransport implements EnvTransport {
  readonly fd: number;
  readonly #name: string;

  constructor({ fd = 3, name = 'factory-agent' }: { fd?: number; name?: string } = {}) {
    if (!Number.isInteger(fd) || fd < 3 || fd > 9) throw new RangeError(`fd ${fd} must be 3–9: one sh redirection digit, past stdio.`);
    this.fd = fd;
    this.#name = name;
  }

  /**
   * The `sh -c` program. The payload ends by setting a marker; without it (no pipe, a cut-off
   * write, a failed eval) the loader exits {@link LOADER_FAILED} instead of running the command
   * without its environment.
   */
  get script(): string {
    const fd = this.fd;
    return [
      `p=$(${SYSTEM_BINARIES.cat} <&${fd}) || exit ${LOADER_FAILED}`,
      `exec ${fd}<&-`,
      `eval "$p" && [ "\${${MARKER}-}" = 1 ] || exit ${LOADER_FAILED}`,
      `unset p ${MARKER}`,
      'exec "$@"',
    ].join('; ');
  }

  loaderArgs(): string[] {
    return [SYSTEM_BINARIES.sh, '-c', this.script, this.#name];
  }

  payload(env: Record<string, string>): string {
    const lines = Object.entries(env)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, value]) => {
        assertEnvName(name);
        return `export ${name}=${shellQuote(value)}`;
      });
    return `${[...lines, `${MARKER}=1`].join('\n')}\n`;
  }
}
