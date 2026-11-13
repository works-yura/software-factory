import type { CommandWrapper } from './command-wrapper.ts';
import { planOf, type LaunchPlan } from './launch-plan.ts';
import type { ProcessLauncher } from './process-launcher.ts';
import type { ProcessSpec } from './process-spec.ts';

/** The command's final environment, from what the spec asks for. */
export type EnvironmentFor = (env: ProcessSpec['env']) => Record<string, string>;

/**
 * A launcher made of wrappers. `environment` gives the command its final environment; the wrappers,
 * listed outermost first as on the command line, are applied innermost first.
 */
export class WrappingLauncher implements ProcessLauncher {
  private readonly wrappers: readonly CommandWrapper[];
  private readonly environment: EnvironmentFor;

  constructor(wrappers: readonly CommandWrapper[], environment: EnvironmentFor) {
    this.wrappers = wrappers;
    this.environment = environment;
  }

  get layers(): string[] {
    return this.wrappers.map(wrapper => wrapper.name);
  }

  plan(spec: ProcessSpec): LaunchPlan {
    const inner = planOf(spec.command, spec.args, this.environment(spec.env));
    return [...this.wrappers].reverse().reduce((plan, wrapper) => wrapper.wrap(plan, spec), inner);
  }
}
