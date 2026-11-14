import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PipeEnvTransport } from '../env/pipe-env-transport.ts';
import { shellQuote } from '../env/shell-quote.ts';
import { WrappingLauncher } from '../launch/wrapping-launcher.ts';
import { EnvLoaderWrapper } from '../launch/wrappers/index.ts';
import type { ProcessLauncher } from '../launch/process-launcher.ts';

import { PrivateFileStash, type InputStash } from './input-stash.ts';
import { ShellCommandBridge } from './shell-command-bridge.ts';

const scratch = () => mkdtempSync(join(tmpdir(), 'agent-user-shell-'));

const loaderOnly = () =>
  new WrappingLauncher([new EnvLoaderWrapper(new PipeEnvTransport())], env =>
    Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
  );

describe('PrivateFileStash', () => {
  it('writes each input to its own owner-only file in an owner-only folder', () => {
    const dir = join(scratch(), 'inputs');
    const stash = new PrivateFileStash(dir);
    const a = stash.put('one');
    const b = stash.put('two');
    expect(a).not.toBe(b);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(a).mode & 0o777).toBe(0o600);
  });

  it('removes inputs nobody picked up within ten minutes', () => {
    const dir = scratch();
    writeFileSync(join(dir, 'unrelated'), '');
    const stash = new PrivateFileStash(dir);
    const old = stash.put('old');
    const past = (Date.now() - 11 * 60_000) / 1000;
    utimesSync(old, past, past);
    const fresh = stash.put('fresh');
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(readdirSync(dir)).toContain('unrelated');
  });
});

describe('ShellCommandBridge', () => {
  it('opens each input on its descriptor, removes it, then execs the plan', () => {
    const paths: string[] = [];
    const stash: InputStash = { put: payload => (paths.push(payload), `/s/in ${paths.length}`) };
    const program = new ShellCommandBridge(loaderOnly(), stash).commandLine('echo hi', { A: '1' });
    expect(paths).toEqual([`export A='1'\n__factory_agent_env_complete=1\n`]);
    expect(program).toBe(
      `exec 3<'/s/in 1' && rm -f '/s/in 1' && exec '/bin/sh' '-c' ${shellQuote(new PipeEnvTransport().script)} 'factory-agent' '/bin/sh' '-c' 'echo hi'`,
    );
  });

  it('keeps the seatbelt opt-out of the spec', () => {
    const seen: unknown[] = [];
    const launcher: ProcessLauncher = { plan: spec => (seen.push(spec), { argv: ['x'], env: {}, inputs: [], crossesUser: false }) };
    new ShellCommandBridge(launcher, { put: () => '' }).commandLine('make', {}, { seatbelt: false });
    new ShellCommandBridge(launcher, { put: () => '' }).commandLine('make', {});
    expect(seen).toEqual([
      { command: '/bin/sh', args: ['-c', 'make'], env: {}, seatbelt: false },
      { command: '/bin/sh', args: ['-c', 'make'], env: {} },
    ]);
  });

  it("refuses a same-user plan's environment: it is the command's own and would land on the command line", () => {
    const launcher: ProcessLauncher = { plan: () => ({ argv: ['x'], env: { SECRET: 's' }, inputs: [], crossesUser: false }) };
    expect(() => new ShellCommandBridge(launcher, { put: () => '' }).commandLine('x', {})).toThrow(/SECRET/);
  });

  it("puts a cross-user launcher's own environment (sudo's PATH) in front of the exec", () => {
    const launcher: ProcessLauncher = { plan: () => ({ argv: ['sudo', '-n'], env: { PATH: '/usr/bin:/bin' }, inputs: [], crossesUser: true }) };
    expect(new ShellCommandBridge(launcher, { put: () => '' }).commandLine('x', {})).toBe(`PATH='/usr/bin:/bin' exec 'sudo' '-n'`);
  });

  it('runs in a real sh: the command gets its environment from the stash, which is gone afterwards', () => {
    const dir = scratch();
    const secret = `it's "quoted" $HOME \`x\`\nnext line`;
    const program = new ShellCommandBridge(loaderOnly(), new PrivateFileStash(dir)).commandLine('printf %s "$TOKEN"', { TOKEN: secret });
    expect(program).not.toContain('quoted');
    const out = execFileSync('/bin/sh', ['-c', program], { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
    expect(out).toBe(secret);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('a missing input stops the shell before the command runs', () => {
    const program = new ShellCommandBridge(loaderOnly(), { put: () => '/nonexistent/input' }).commandLine('echo ran', { A: '1' });
    let out = '';
    try {
      out = execFileSync('/bin/sh', ['-c', program], { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (error) {
      out = String((error as { stdout?: string }).stdout ?? '');
    }
    expect(out).not.toContain('ran');
  });
});
