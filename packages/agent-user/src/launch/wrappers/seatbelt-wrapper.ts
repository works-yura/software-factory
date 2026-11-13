import { SYSTEM_BINARIES } from '../../system/paths.ts';
import type { CommandWrapper } from '../command-wrapper.ts';
import type { LaunchPlan } from '../launch-plan.ts';
import type { ProcessSpec } from '../process-spec.ts';

/**
 * `sandbox-exec -f <profile>` around the command, unless the spec opts out (tools with their own
 * sandbox). The profile is a file the agent cannot change, not one the server writes per run.
 */
export class SeatbeltWrapper implements CommandWrapper {
  readonly name = 'seatbelt';

  private readonly profilePath: string;

  constructor(profilePath: string) {
    this.profilePath = profilePath;
  }

  wrap(plan: LaunchPlan, spec: ProcessSpec): LaunchPlan {
    if (spec.seatbelt === false) return plan;
    return { ...plan, argv: [SYSTEM_BINARIES.sandboxExec, '-f', this.profilePath, ...plan.argv] };
  }
}
