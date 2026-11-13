import { SYSTEM_BINARIES } from '../../system/paths.ts';
import type { CommandWrapper } from '../command-wrapper.ts';
import type { LaunchPlan } from '../launch-plan.ts';

/**
 * `env -i NAME=value…` around the command: whatever crosses into it, nothing else does. Only
 * non-secret variables belong here; they are on the command line.
 */
export class ClearEnvWrapper implements CommandWrapper {
  readonly name = 'clear-env';

  private readonly visible: Readonly<Record<string, string>>;

  constructor(visible: Readonly<Record<string, string>>) {
    this.visible = visible;
  }

  wrap(plan: LaunchPlan): LaunchPlan {
    const assignments = Object.entries(this.visible).map(([name, value]) => `${name}=${value}`);
    return { ...plan, argv: [SYSTEM_BINARIES.env, '-i', ...assignments, ...plan.argv], env: {} };
  }
}
