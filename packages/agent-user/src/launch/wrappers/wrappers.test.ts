import { describe, expect, it } from 'vitest';

import { PipeEnvTransport } from '../../env/pipe-env-transport.ts';
import { planOf } from '../launch-plan.ts';

import { ClearEnvWrapper } from './clear-env-wrapper.ts';
import { EnvLoaderWrapper } from './env-loader-wrapper.ts';
import { SeatbeltWrapper } from './seatbelt-wrapper.ts';
import { SudoWrapper } from './sudo-wrapper.ts';

const spec = { command: '/bin/claude', args: ['-p'], env: {} };
const base = planOf('/bin/claude', ['-p'], { TOKEN: 'secret' });

describe('SeatbeltWrapper', () => {
  it('puts sandbox-exec with the profile in front', () => {
    expect(new SeatbeltWrapper('/var/factory/a.sb').wrap(base, spec).argv).toEqual(['/usr/bin/sandbox-exec', '-f', '/var/factory/a.sb', '/bin/claude', '-p']);
  });
  it('steps aside for tools that sandbox themselves', () => {
    expect(new SeatbeltWrapper('/x.sb').wrap(base, { ...spec, seatbelt: false })).toBe(base);
  });
});

describe('EnvLoaderWrapper', () => {
  const wrapped = new EnvLoaderWrapper(new PipeEnvTransport()).wrap(base);
  it('moves the environment to fd 3 and empties env', () => {
    expect(wrapped.env).toEqual({});
    expect(wrapped.inputs).toEqual([{ fd: 3, payload: expect.stringContaining("export TOKEN='secret'") }]);
    expect(wrapped.argv.join(' ')).not.toContain('secret');
    expect(wrapped.argv.slice(-2)).toEqual(['/bin/claude', '-p']);
  });
});

describe('ClearEnvWrapper', () => {
  it('starts from an empty environment with only the visible variables', () => {
    const wrapped = new ClearEnvWrapper({ HOME: '/Users/factory' }).wrap(base);
    expect(wrapped.argv).toEqual(['/usr/bin/env', '-i', 'HOME=/Users/factory', '/bin/claude', '-p']);
    expect(wrapped.env).toEqual({});
  });
});

describe('SudoWrapper', () => {
  it('never asks for a password and marks the plan as crossing users', () => {
    const wrapped = new SudoWrapper('factory').wrap(base);
    expect(wrapped.argv).toEqual(['/usr/bin/sudo', '-n', '-u', 'factory', '--', '/bin/claude', '-p']);
    expect(wrapped.env).toEqual({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin' });
    expect(wrapped.crossesUser).toBe(true);
  });
  it('keeps the extra descriptors open across sudo', () => {
    const withPipe = { ...base, inputs: [{ fd: 3, payload: 'x' }] };
    expect(new SudoWrapper('factory').wrap(withPipe).argv.slice(0, 4)).toEqual(['/usr/bin/sudo', '-n', '-C', '4']);
  });
  it('ends its options with -- so a command cannot pass as one', () => {
    const tricky = planOf('-s', [], {});
    const argv = new SudoWrapper('factory').wrap(tricky).argv;
    expect(argv.indexOf('--')).toBeLessThan(argv.indexOf('-s'));
  });
});

describe('EnvLoaderWrapper with a broken transport', () => {
  it('refuses a transport without a loader', () => {
    const transport = { fd: 3, loaderArgs: () => [], payload: () => '' };
    expect(() => new EnvLoaderWrapper(transport).wrap(base)).toThrow(/no loader/);
  });
});
