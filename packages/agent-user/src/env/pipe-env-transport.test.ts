import { spawn } from 'node:child_process';
import type { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { nastyValue } from '../testing/fixtures.ts';

import { LOADER_FAILED, PipeEnvTransport } from './pipe-env-transport.ts';

/** Runs the loader for real: payload on the fd, then `env` prints what it got. */
async function loadAndPrint(transport: PipeEnvTransport, env: Record<string, string>) {
  const [sh, ...rest] = transport.loaderArgs();
  const stdio = Array.from({ length: transport.fd + 1 }, (_, fd) => (fd === 0 ? 'ignore' : 'pipe')) as ('pipe' | 'ignore')[];
  const child = spawn('/usr/bin/env', ['-i', sh as string, ...rest, '/usr/bin/env'], { stdio });
  (child.stdio[transport.fd] as Writable).end(transport.payload(env));
  let out = '';
  let err = '';
  child.stdout?.on('data', chunk => (out += chunk));
  child.stderr?.on('data', chunk => (err += chunk));
  const code = await new Promise(resolve => child.on('close', resolve));
  return { out, err, code };
}

describe('PipeEnvTransport', () => {
  it('delivers values exactly, whatever they hold', async () => {
    const { out, err, code } = await loadAndPrint(new PipeEnvTransport(), { TOKEN: nastyValue, EMPTY: '', LANG: 'uk_UA.UTF-8' });
    expect(err).toBe('');
    expect(code).toBe(0);
    expect(out).toContain(`TOKEN=${nastyValue}\n`);
    expect(out).toContain('EMPTY=\n');
    expect(out).toContain('LANG=uk_UA.UTF-8\n');
  });

  it('works on another descriptor', async () => {
    const { out } = await loadAndPrint(new PipeEnvTransport({ fd: 5 }), { A: '1' });
    expect(out).toContain('A=1\n');
  });

  it('never puts a value on the command line', () => {
    const transport = new PipeEnvTransport();
    expect(transport.loaderArgs().join(' ')).not.toContain('secret');
    expect(transport.payload({ T: 'secret' })).toBe("export T='secret'\n__factory_agent_env_complete=1\n");
  });

  it('sorts its lines, so the payload is stable', () => {
    expect(new PipeEnvTransport().payload({ B: '2', A: '1' })).toBe("export A='1'\nexport B='2'\n__factory_agent_env_complete=1\n");
  });

  it('refuses names eval would misread and descriptors sh cannot name', () => {
    expect(() => new PipeEnvTransport().payload({ 'A;id': 'x' })).toThrow(/not allowed/);
    expect(() => new PipeEnvTransport({ fd: 2 })).toThrow(RangeError);
    expect(() => new PipeEnvTransport({ fd: 10 })).toThrow(RangeError);
  });

  it('a missing payload fails the command instead of running it without its environment', async () => {
    const transport = new PipeEnvTransport();
    const [sh, ...rest] = transport.loaderArgs();
    const child = spawn('/usr/bin/env', ['-i', sh as string, ...rest, '/usr/bin/true'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const code = await new Promise(resolve => child.on('close', resolve));
    expect(code).toBe(LOADER_FAILED);
  });

  it('a cut-off payload fails the command too', async () => {
    const transport = new PipeEnvTransport();
    const [sh, ...rest] = transport.loaderArgs();
    const child = spawn('/usr/bin/env', ['-i', sh as string, ...rest, '/usr/bin/true'], { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
    const full = transport.payload({ TOKEN: 'abc' });
    (child.stdio[3] as Writable).end(full.slice(0, full.indexOf('__factory')));
    const code = await new Promise(resolve => child.on('close', resolve));
    expect(code).toBe(LOADER_FAILED);
  });

  it('the marker never reaches the command', async () => {
    const { out } = await loadAndPrint(new PipeEnvTransport(), { A: '1' });
    expect(out).not.toContain('__factory');
    expect(out).not.toMatch(/^p=/m);
  });
});
