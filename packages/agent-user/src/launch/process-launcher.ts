import type { LaunchPlan } from './launch-plan.ts';
import type { ProcessSpec } from './process-spec.ts';

/** Turns what a harness wants to run into what to spawn (Strategy). */
export interface ProcessLauncher {
  plan(spec: ProcessSpec): LaunchPlan;
}
