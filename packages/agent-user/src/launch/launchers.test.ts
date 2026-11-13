import { describe, expect, it } from 'vitest';

import { LOADER_FAILED } from '../env/pipe-env-transport.ts';
import { agentConfig, nastyValue } from '../testing/fixtures.ts';

import { createAgentUserLauncher } from './agent-user-launcher.ts';
import type { CommandWrapper } from './command-wrapper.ts';
import { SameUserLauncher } from './same-user-launcher.ts';
import { WrappingLauncher } from './wrapping-launcher.ts';

describe('SameUserLauncher', () => {
  it('runs the command as is, without unset variables', () => {
    expect(new SameUserLauncher().plan({ command: '/bin/x', args: ['a'], env: { A: '1', B: undefined } })).toEqual({ argv: ['/bin/x', 'a'], env: { A: '1' }, inputs: [], crossesUser: false });
  });
});

describe('WrappingLauncher', () => {
  it('applies wrappers innermost first, so the list reads like the command line', () => {
    const tag = (name: string): CommandWrapper => ({ name, wrap: plan => ({ ...plan, argv: [name, ...plan.argv] }) });
    const launcher = new WrappingLauncher([tag('outer'), tag('inner')], () => ({}));
    expect(launcher.plan({ command: 'cmd', args: [], env: {} }).argv).toEqual(['outer', 'inner', 'cmd']);
    expect(launcher.layers).toEqual(['outer', 'inner']);
  });
});

describe('createAgentUserLauncher', () => {
  const launcher = createAgentUserLauncher(agentConfig);
  const plan = launcher.plan({ command: '/Users/factory/.local/bin/claude', args: ['-p', 'a b'], env: { HOME: '/Users/yura', CLAUDE_CODE_OAUTH_TOKEN: nastyValue } });

  it('is sudo → env -i → loader → sandbox-exec → command, in that order', () => {
    expect(launcher.layers).toEqual(['sudo', 'clear-env', 'env-loader', 'seatbelt']);
    const at = (arg: string) => plan.argv.indexOf(arg);
    expect(plan.argv[0]).toBe('/usr/bin/sudo');
    expect(at('/usr/bin/sudo')).toBeLessThan(at('/usr/bin/env'));
    expect(at('/usr/bin/env')).toBeLessThan(at('/bin/sh'));
    expect(at('/bin/sh')).toBeLessThan(at('/usr/bin/sandbox-exec'));
    expect(plan.argv.slice(-3)).toEqual(['/Users/factory/.local/bin/claude', '-p', 'a b']);
  });

  it('keeps every secret and the server home off the command line', () => {
    const argv = plan.argv.join('\n');
    expect(argv).not.toContain('sk-');
    expect(argv).not.toContain('/Users/yura');
    expect(plan.inputs[0]?.payload).toContain('CLAUDE_CODE_OAUTH_TOKEN=');
    expect(plan.env).toEqual({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin' });
  });

  it('sudo keeps exactly the descriptor the environment travels on', () => {
    expect(plan.argv.slice(0, 6)).toEqual(['/usr/bin/sudo', '-n', '-C', '4', '-u', 'factory']);
    expect(plan.inputs.map(input => input.fd)).toEqual([3]);
  });

  it('the chain below sudo runs for real and the command sees only the agent identity and its variables', async () => {
    const { spawn } = await import('node:child_process');
    const below = plan.argv.slice(plan.argv.indexOf('/usr/bin/env'));
    // Without sandbox-exec (the profile file is not installed here) and printing the environment.
    const shAt = below.indexOf('/bin/sh');
    const argv = [...below.slice(0, shAt + 4), '/usr/bin/env'];
    const child = spawn(argv[0] as string, argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
    (child.stdio[3] as import('node:stream').Writable).end(plan.inputs[0]?.payload);
    let out = '';
    child.stdout?.on('data', chunk => (out += chunk));
    const code = await new Promise(resolve => child.on('close', resolve));
    expect(code).not.toBe(LOADER_FAILED);
    expect(out).toContain(`CLAUDE_CODE_OAUTH_TOKEN=${nastyValue}\n`);
    expect(out).toContain('HOME=/Users/factory\n');
    expect(out).toContain('TMPDIR=/Users/factory/.tmp/\n');
    expect(out).not.toContain('/Users/yura');
  });

  it('leaves sandbox-exec out for xcodebuild and swift', () => {
    expect(launcher.plan({ command: '/usr/bin/xcodebuild', args: [], env: {}, seatbelt: false }).argv).not.toContain('/usr/bin/sandbox-exec');
  });
});

describe('planOf', () => {
  it('refuses an empty command', async () => {
    const { planOf } = await import('./launch-plan.ts');
    expect(() => planOf('', [], {})).toThrow(/No command/);
  });
});
