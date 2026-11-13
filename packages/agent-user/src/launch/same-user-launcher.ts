import { planOf, type LaunchPlan } from './launch-plan.ts';
import type { ProcessLauncher } from './process-launcher.ts';
import type { ProcessSpec } from './process-spec.ts';

/** Runs the command as is, as the server's user: what Factory does without an agent user. */
export class SameUserLauncher implements ProcessLauncher {
  plan(spec: ProcessSpec): LaunchPlan {
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(spec.env)) if (value !== undefined) env[name] = value;
    return planOf(spec.command, spec.args, env);
  }
}
