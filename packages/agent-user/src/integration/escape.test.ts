/**
 * The agent cannot get out: for every probe in escape-probes.ts the server user reaches the
 * target (the control) and the agent user is refused. Runs with the Seatbelt profile off, as
 * prod does, so the Unix permissions and the pf rule hold on their own, and again with it on.
 * Opt-in like as-agent-user.test.ts: FACTORY_AGENT_USER_TEST=factory. Ports the owner accepts the
 * agent reaching: FACTORY_AGENT_USER_TEST_ALLOWED_PORTS=5000,7000.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { agentConfig, agentUserReady, asAgent, asServer } from './agent-shell.ts';
import { fileProbes, ownerListeners, portProbes, readProbes, writeProbes } from './escape-probes.ts';

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
const ready = agentUserReady();
const ports = ready ? portProbes(ownerListeners()) : [];

describe.runIf(ready).each(['off', 'on'] as const)('as the agent user, Seatbelt %s', seatbelt => {
  const config = agentConfig(seatbelt);

  describe.each(readProbes.filter(probe => existsSync(probe.path)))('cannot read $what', probe => {
    const script = `${probe.read} ${quote(probe.path)}`;

    it('while the server can', async () => {
      expect((await asServer(script)).code).toBe(0);
    });

    it('as the agent', async () => {
      const { code, out } = await asAgent(config, script);
      expect(code).not.toBe(0);
      expect(out).toBe('');
    });
  });

  it.each(writeProbes.filter(probe => existsSync(probe.folder)))('cannot write in $what', async ({ folder }) => {
    const file = quote(`${folder}/zz-agent-escape-probe-${process.pid}`);
    // Removed again by the agent if it ever gets in, so a failure leaves nothing behind.
    const { code } = await asAgent(config, `: > ${file} && rm -f ${file}`);
    expect(code).not.toBe(0);
  });

  it.each(fileProbes.filter(probe => existsSync(probe.path)))('cannot $what', async ({ path, test }) => {
    expect((await asAgent(config, `/bin/test ${test} ${quote(path)}`)).code).not.toBe(0);
  });

  // Every port the owner listens on, found at run time: an app's local API or a simulator's
  // test runner would let the agent act as the owner as surely as the Factory port would.
  it.for(ports)('cannot connect to $what', async ({ host, port }, context) => {
    const script = `/usr/bin/nc -z -G 2 ${quote(host)} ${port}`;
    if ((await asServer(script)).code !== 0) context.skip();
    expect((await asAgent(config, script)).code).not.toBe(0);
  });

  it.each([
    ['use sudo', 'sudo -n true'],
    ['read or change the firewall', '/sbin/pfctl -s rules'],
  ])('cannot %s', async (_what, script) => {
    expect((await asAgent(config, script)).code).not.toBe(0);
  });

  // Their environment (`ps -E`) is no probe: this macOS shows no environment even to the owner.
  describe("the owner's processes", () => {
    let owner: ReturnType<typeof spawn>;

    beforeAll(() => {
      owner = spawn('/bin/sleep', ['300'], { stdio: 'ignore' });
    });
    afterAll(() => {
      owner.kill('SIGKILL');
    });

    it('cannot be signalled', async () => {
      expect((await asAgent(config, `kill -0 ${owner.pid}`)).code).not.toBe(0);
    });
  });
});

describe('the escape check', () => {
  it.runIf(!ready)('is skipped: set FACTORY_AGENT_USER_TEST after scripts/mac-mini/isolation/2-system.sh agent-sudo', () => {
    expect(ready).toBe(false);
  });
});
