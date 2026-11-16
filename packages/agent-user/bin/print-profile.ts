/**
 * Prints the agent's Seatbelt profile for the configuration in the environment
 * (`FACTORY_AGENT_USER`, `MASTRACODE_LOCAL_SANDBOX_ROOT`, the toolchain folders of
 * `FACTORY_AGENT_TOOLCHAIN_ENV` / `FACTORY_AGENT_READABLE`, read-only, …): what
 * `scripts/mac-mini/isolation/2-system.sh agent-profile` installs, root-owned, for every agent
 * command. Run with Node's type stripping: `node packages/agent-user/bin/print-profile.ts`.
 */

import { agentUserFromEnv } from '../src/config/from-env.ts';
import { SeatbeltAgentPolicy } from '../src/seatbelt/agent-policy.ts';

const config = agentUserFromEnv(process.env, {
  serverUser: process.env.FACTORY_SERVER_USER ?? process.env.SUDO_USER ?? process.env.USER ?? '',
  sandboxRoot: process.env.MASTRACODE_LOCAL_SANDBOX_ROOT ?? '',
});
if (!config) {
  process.stderr.write('Set FACTORY_AGENT_USER (and MASTRACODE_LOCAL_SANDBOX_ROOT).\n');
  process.exit(2);
}
process.stdout.write(new SeatbeltAgentPolicy({ home: config.home, writableRoots: config.writableRoots, readableRoots: config.readableRoots ?? [] }).render());
