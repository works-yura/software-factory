import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSignInCommandRunner } from './sign-in-command.ts';

class ProviderError extends Error {}

const run = createSignInCommandRunner({ name: 'Claude', error: message => new ProviderError(message), stopGraceMs: 200 });
const env = { PATH: '/usr/bin:/bin' };

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A `claude auth login` that waits on the browser forever and shrugs SIGTERM off, writing its pid first. */
function stubbornLogin() {
  const dir = mkdtempSync(join(tmpdir(), 'sign-in-command-'));
  dirs.push(dir);
  const pidFile = join(dir, 'pid');
  const script = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`;
  return { args: ['-e', script], pid: () => Number(readFileSync(pidFile, 'utf8')), pidFile };
}

describe.skipIf(process.platform === 'win32')('createSignInCommandRunner', () => {
  it('returns what the command printed and its exit code', async () => {
    const result = await run('/bin/sh', ['-c', 'echo signed in; echo warn >&2; exit 3'], { env, timeoutMs: 5_000 });
    expect(result).toEqual({ code: 3, stdout: 'signed in\n', stderr: 'warn\n' });
  });

  it('says why a command cannot start', async () => {
    await expect(run('/nowhere/claude', ['auth', 'login'], { env, timeoutMs: 5_000 })).rejects.toThrow(
      new ProviderError('/nowhere/claude could not start: spawn /nowhere/claude ENOENT'),
    );
  });

  it.each(['timed out', 'cancelled'] as const)(
    'settles a sign-in that %s only once the CLI is gone, killing one that ignores SIGTERM',
    async outcome => {
      const login = stubbornLogin();
      const controller = new AbortController();
      const result = run(process.execPath, login.args, { env, timeoutMs: outcome === 'timed out' ? 300 : 60_000, signal: controller.signal });
      await vi.waitFor(() => expect(readFileSync(login.pidFile, 'utf8')).not.toBe(''));
      if (outcome === 'cancelled') controller.abort();
      await expect(result).rejects.toThrow(outcome === 'cancelled' ? 'Claude sign-in was cancelled.' : 'timed out.');
      // The caller removes the sign-in dir and Keychain item next: nothing may still be signing in.
      expect(isAlive(login.pid())).toBe(false);
    },
    10_000,
  );

  it('starts nothing for a sign-in cancelled before it began', async () => {
    const controller = new AbortController();
    controller.abort();
    const login = stubbornLogin();
    await expect(run(process.execPath, login.args, { env, timeoutMs: 60_000, signal: controller.signal })).rejects.toThrow(
      'Claude sign-in was cancelled.',
    );
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(() => readFileSync(login.pidFile)).toThrow();
  });
});
