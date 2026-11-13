import type { LaunchPlan } from './launch-plan.ts';
import type { ProcessSpec } from './process-spec.ts';

/**
 * One layer around a command (Decorator): sudo, a cleared environment, an environment loader, a
 * sandbox. Each takes the plan so far and returns it wrapped; a launcher applies them innermost
 * first, so each can be replaced, removed or added without touching the others.
 */
export interface CommandWrapper {
  readonly name: string;
  wrap(plan: LaunchPlan, spec: ProcessSpec): LaunchPlan;
}
