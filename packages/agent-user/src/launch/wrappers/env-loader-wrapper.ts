import type { EnvTransport } from '../../env/env-transport.ts';
import type { CommandWrapper } from '../command-wrapper.ts';
import type { LaunchPlan } from '../launch-plan.ts';

/**
 * Moves the command's environment off the command line into the transport (a pipe): the loader
 * goes in front, the values go to the transport's descriptor, and nothing is left in `env`.
 */
export class EnvLoaderWrapper implements CommandWrapper {
  readonly name = 'env-loader';

  private readonly transport: EnvTransport;

  constructor(transport: EnvTransport) {
    this.transport = transport;
  }

  wrap(plan: LaunchPlan): LaunchPlan {
    const [first, ...rest] = this.transport.loaderArgs();
    if (!first) throw new Error('The environment transport has no loader.');
    return {
      ...plan,
      argv: [first, ...rest, ...plan.argv],
      env: {},
      inputs: [...plan.inputs, { fd: this.transport.fd, payload: this.transport.payload({ ...plan.env }) }],
    };
  }
}
