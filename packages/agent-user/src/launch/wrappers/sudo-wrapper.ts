import { SYSTEM_BINARIES, SYSTEM_PATH } from '../../system/paths.ts';
import type { CommandWrapper } from '../command-wrapper.ts';
import type { LaunchPlan } from '../launch-plan.ts';

/**
 * `sudo -n -u <user> --` around the command. `-n`: never ask for a password, so a missing sudoers
 * rule fails the start at once. `-C`: keep the plan's extra descriptors open (sudo closes everything
 * past stdio otherwise; the sudoers rule allows it with `closefrom_override`). sudo itself gets only
 * the system PATH. The working directory is inherited.
 */
export class SudoWrapper implements CommandWrapper {
  readonly name = 'sudo';

  private readonly user: string;

  constructor(user: string) {
    this.user = user;
  }

  wrap(plan: LaunchPlan): LaunchPlan {
    const highestFd = Math.max(2, ...plan.inputs.map(input => input.fd));
    const keep = highestFd > 2 ? ['-C', String(highestFd + 1)] : [];
    return {
      ...plan,
      argv: [SYSTEM_BINARIES.sudo, '-n', ...keep, '-u', this.user, '--', ...plan.argv],
      env: { PATH: SYSTEM_PATH.join(':') },
      crossesUser: true,
    };
  }
}
