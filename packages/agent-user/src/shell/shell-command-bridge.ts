import { shellQuote } from '../env/shell-quote.ts';
import type { ProcessLauncher } from '../launch/process-launcher.ts';
import type { ProcessSpec } from '../launch/process-spec.ts';

import type { InputStash } from './input-stash.ts';

/**
 * For callers that can only run a shell command line (Mastra's `LocalSandbox`): the launcher's plan
 * as one `sh` program. Each planned input goes to the stash and is opened on its descriptor, then
 * removed, before the plan's argv is exec'd; so the agent's environment never appears on a command
 * line. Only a launch that crosses to another user (whose wrappers moved the command's environment to
 * an input) may keep an environment of its own, the launcher's (sudo's `PATH`): it goes on the line.
 */
export class ShellCommandBridge {
  readonly #launcher: ProcessLauncher;
  readonly #stash: InputStash;

  constructor(launcher: ProcessLauncher, stash: InputStash) {
    this.#launcher = launcher;
    this.#stash = stash;
  }

  /** `sh -c <command>` as the launcher runs it, with `env` as the command's environment. */
  commandLine(command: string, env: ProcessSpec['env'], options: { seatbelt?: boolean } = {}): string {
    return this.program({ command: '/bin/sh', args: ['-c', command], env, ...(options.seatbelt === false ? { seatbelt: false } : {}) });
  }

  program(spec: ProcessSpec): string {
    const plan = this.#launcher.plan(spec);
    const own = Object.entries(plan.env);
    if (own.length && !plan.crossesUser) {
      throw new Error(`A shell bridge would put the command's environment on its command line (${own.map(([name]) => name).join(', ')}).`);
    }
    const steps: string[] = [];
    for (const input of plan.inputs) {
      const path = shellQuote(this.#stash.put(input.payload));
      steps.push(`exec ${input.fd}<${path}`, `rm -f ${path}`);
    }
    const assignments = own.map(([name, value]) => `${name}=${shellQuote(value)} `).join('');
    steps.push(`${assignments}exec ${plan.argv.map(shellQuote).join(' ')}`);
    return steps.join(' && ');
  }
}
