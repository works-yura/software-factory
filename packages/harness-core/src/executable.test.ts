import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  createHarnessExecutable,
  formatHarnessExecutableReport,
  harnessCommandAvailable,
  harnessCommandPath,
  HarnessExecutableUnavailableError,
  isHarnessExecutableUnavailable,
  readExecutableVersion,
  reportHarnessSpawnFailure,
  resolveHarnessExecutable,
  wellKnownExecutableDirs,
} from './executable.ts';

function binDir(prefix: string, names: readonly string[], script = '#!/bin/sh\necho "2.1.0 (Claude Code)"\n'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  for (const name of names) {
    writeFileSync(join(dir, name), script);
    chmodSync(join(dir, name), 0o755);
  }
  return dir;
}

function spawnEnoent(command: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`spawn ${command} ENOENT`), { code: 'ENOENT', syscall: `spawn ${command}`, path: command });
}

describe('resolveHarnessExecutable', () => {
  it('finds the executable on PATH first, then in the well-known directories', () => {
    const onPath = binDir('exe-path-', ['claude']);
    const local = binDir('exe-local-', ['claude', 'codex']);
    const spec = { harness: 'Claude Code', name: 'claude', wellKnownDirs: [local], platform: 'darwin' as const };

    expect(resolveHarnessExecutable({ ...spec, env: { PATH: `/nowhere:${onPath}` } })).toEqual({
      found: true,
      path: join(onPath, 'claude'),
      source: 'path',
      searched: ['/nowhere/claude', join(onPath, 'claude')],
    });
    // The launchd case: a bare PATH, the CLI in ~/.local/bin.
    expect(resolveHarnessExecutable({ ...spec, env: { PATH: '/usr/bin:/bin' } })).toMatchObject({
      found: true,
      path: join(local, 'claude'),
      source: 'well-known',
    });
  });

  it('says where it looked when the executable is nowhere', () => {
    const resolution = resolveHarnessExecutable({
      harness: 'Codex',
      name: 'codex',
      env: { PATH: '/usr/bin' },
      wellKnownDirs: ['/opt/homebrew/bin', '/usr/bin'],
      isExecutable: () => false,
      platform: 'darwin',
    });
    expect(resolution).toEqual({ found: false, searched: ['/usr/bin/codex', '/opt/homebrew/bin/codex'] });
  });

  it('takes a configured path as is, and only that path', () => {
    const local = binDir('exe-configured-', ['claude']);
    const configured = join(local, 'claude');
    expect(resolveHarnessExecutable({ harness: 'Claude Code', name: 'claude', configured, env: { PATH: '' } })).toEqual({
      found: true,
      path: configured,
      source: 'configured',
      searched: [configured],
    });
    // A wrong path is not "fixed" by running some other claude from PATH.
    const missing = join(local, 'nope');
    expect(resolveHarnessExecutable({ harness: 'Claude Code', name: 'claude', configured: missing, env: { PATH: local } })).toEqual({
      found: false,
      searched: [missing],
    });
  });

  it('looks a configured bare name up like the default one', () => {
    const local = binDir('exe-named-', ['claude-nightly']);
    expect(
      resolveHarnessExecutable({ harness: 'Claude Code', name: 'claude', configured: ' claude-nightly ', env: { PATH: '' }, wellKnownDirs: [local] }),
    ).toMatchObject({ found: true, path: join(local, 'claude-nightly'), source: 'configured' });
  });

  it('does not take a directory or a non-executable file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'exe-not-'));
    mkdirSync(join(dir, 'claude'));
    writeFileSync(join(dir, 'codex'), 'not executable');
    expect(resolveHarnessExecutable({ harness: 'Claude Code', name: 'claude', env: { PATH: dir }, wellKnownDirs: [] }).found).toBe(false);
    expect(resolveHarnessExecutable({ harness: 'Codex', name: 'codex', env: { PATH: dir }, wellKnownDirs: [] }).found).toBe(false);
  });
});

describe('wellKnownExecutableDirs', () => {
  it("names ~/.local/bin, ~/.claude/local, the server's node bin, nvm's, Homebrew and /usr/local/bin", () => {
    expect(
      wellKnownExecutableDirs({
        env: { NVM_BIN: '/Users/a/.nvm/versions/node/v24.1.0/bin' },
        home: '/Users/a',
        execPath: '/Users/a/.nvm/versions/node/v24.1.0/bin/node',
        platform: 'darwin',
      }),
    ).toEqual(['/Users/a/.local/bin', '/Users/a/.claude/local', '/Users/a/.nvm/versions/node/v24.1.0/bin', '/opt/homebrew/bin', '/usr/local/bin']);
  });
});

describe('createHarnessExecutable', () => {
  it('keeps a found executable: later lookups cost nothing', () => {
    const isExecutable = vi.fn((path: string) => path === '/home/a/.local/bin/claude');
    const executable = createHarnessExecutable({
      harness: 'Claude Code',
      name: 'claude',
      env: { PATH: '/usr/bin' },
      wellKnownDirs: ['/home/a/.local/bin'],
      isExecutable,
    });
    expect(executable.command()).toBe('/home/a/.local/bin/claude');
    const calls = isExecutable.mock.calls.length;
    expect(executable.command()).toBe('/home/a/.local/bin/claude');
    expect(isExecutable.mock.calls.length).toBe(calls);
    // Availability checks the kept file alone, never looks it up again.
    expect(executable.unavailableReason()).toBeUndefined();
    expect(isExecutable.mock.calls.slice(calls)).toEqual([['/home/a/.local/bin/claude']]);
  });

  it('reads a kept CLI that was removed since as missing, and finds it again once reinstalled', async () => {
    let present = true;
    const executable = createHarnessExecutable({
      harness: 'Claude Code',
      name: 'claude',
      env: { PATH: '/usr/bin' },
      wellKnownDirs: ['/home/a/.local/bin'],
      isExecutable: path => present && path === '/home/a/.local/bin/claude',
      readVersion: async () => '2.1.0',
    });
    expect(executable.unavailableReason()).toBeUndefined();

    present = false;
    expect(executable.unavailableReason()).toContain('Claude Code is not installed on this server');
    expect(await executable.report()).toMatchObject({ found: false });
    expect(() => executable.command()).toThrow(HarnessExecutableUnavailableError);

    present = true;
    expect(executable.unavailableReason()).toBeUndefined();
    expect(executable.command()).toBe('/home/a/.local/bin/claude');
  });

  it('looks again while missing, so an install after boot is picked up without a restart', () => {
    let installed = false;
    const executable = createHarnessExecutable({
      harness: 'Claude Code',
      name: 'claude',
      setting: 'FACTORY_CLAUDE_CODE_COMMAND',
      env: { PATH: '/usr/bin' },
      wellKnownDirs: ['/home/a/.local/bin'],
      isExecutable: path => installed && path === '/home/a/.local/bin/claude',
    });
    expect(executable.unavailableReason()).toBe(
      'Claude Code is not installed on this server: `claude` was not found. Looked in: /usr/bin, /home/a/.local/bin. ' +
        'Install it, or set FACTORY_CLAUDE_CODE_COMMAND to its absolute path, and the harness becomes available without a restart.',
    );
    const error = (() => {
      try {
        executable.command();
      } catch (thrown) {
        return thrown;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(HarnessExecutableUnavailableError);
    expect(error).toMatchObject({ harness: 'Claude Code', executable: 'claude', searched: ['/usr/bin/claude', '/home/a/.local/bin/claude'] });

    installed = true;
    expect(executable.command()).toBe('/home/a/.local/bin/claude');
  });

  it('drops the kept path when spawning it fails for good, and only then', () => {
    let present = true;
    const executable = createHarnessExecutable({
      harness: 'Codex',
      name: 'codex',
      env: { PATH: '/bin' },
      wellKnownDirs: [],
      isExecutable: path => present && path === '/bin/codex',
    });
    expect(executable.command()).toBe('/bin/codex');
    present = false;
    executable.spawnFailed(new Error('turn timed out'));
    expect(executable.command()).toBe('/bin/codex');
    executable.spawnFailed(spawnEnoent('/bin/codex'));
    expect(() => executable.command()).toThrow(HarnessExecutableUnavailableError);
  });

  it('reports path, source and version (read once per path), or the reason', async () => {
    const readVersion = vi.fn(async () => 'codex-cli 0.80.0');
    const found = createHarnessExecutable({ harness: 'Codex', name: 'codex', env: { PATH: '/bin' }, wellKnownDirs: [], isExecutable: p => p === '/bin/codex', readVersion });
    const report = await found.report();
    await found.report();
    expect(report).toEqual({ harness: 'Codex', name: 'codex', found: true, path: '/bin/codex', source: 'path', version: 'codex-cli 0.80.0', searched: ['/bin/codex'] });
    expect(readVersion).toHaveBeenCalledTimes(1);
    expect(formatHarnessExecutableReport(report)).toBe('Codex: /bin/codex (path, codex-cli 0.80.0).');

    const missing = createHarnessExecutable({ harness: 'Codex', name: 'codex', env: { PATH: '/bin' }, wellKnownDirs: [], isExecutable: () => false });
    const missingReport = await missing.report();
    expect(missingReport).toMatchObject({ found: false, searched: ['/bin/codex'], reason: expect.stringContaining('Codex is not installed on this server') });
    expect(formatHarnessExecutableReport(missingReport)).toBe('Codex: `codex` not found (looked in /bin/codex).');
  });
});

describe('readExecutableVersion', () => {
  it("reads the first line of the CLI's --version", async () => {
    const dir = binDir('exe-version-', ['claude']);
    expect(await readExecutableVersion(join(dir, 'claude'))).toBe('2.1.0 (Claude Code)');
    expect(await readExecutableVersion(join(dir, 'missing'))).toBeUndefined();
  });
});

describe('isHarnessExecutableUnavailable', () => {
  it("recognises a missing executable through the harness error's causes, and nothing else", () => {
    const harnessError = Object.assign(new Error('Unable to start Claude Code: spawn claude ENOENT'), { kind: 'process', cause: spawnEnoent('claude') });
    expect(isHarnessExecutableUnavailable(harnessError)).toBe(true);
    expect(isHarnessExecutableUnavailable(new HarnessExecutableUnavailableError({ harness: 'Codex', executable: 'codex' }))).toBe(true);
    expect(isHarnessExecutableUnavailable({ error: { code: 'EACCES', syscall: 'spawn /bin/codex' } })).toBe(true);
    // The same words without the structure, or a missing file elsewhere, are someone else's failure.
    expect(isHarnessExecutableUnavailable(new Error('spawn claude ENOENT'))).toBe(false);
    expect(isHarnessExecutableUnavailable(Object.assign(new Error('open'), { code: 'ENOENT', syscall: 'open' }))).toBe(false);
    expect(isHarnessExecutableUnavailable(undefined)).toBe(false);
  });
});

describe('harnessCommandPath and reportHarnessSpawnFailure', () => {
  it('spawn a fixed command as is, and ask a source each time', () => {
    const source = { command: vi.fn(() => '/bin/claude'), spawnFailed: vi.fn() };
    expect(harnessCommandPath(undefined, 'claude')).toBe('claude');
    expect(harnessCommandPath('/opt/claude', 'claude')).toBe('/opt/claude');
    expect(harnessCommandPath(source, 'claude')).toBe('/bin/claude');

    reportHarnessSpawnFailure(source, new Error('exit 1'));
    expect(source.spawnFailed).not.toHaveBeenCalled();
    reportHarnessSpawnFailure(source, spawnEnoent('/bin/claude'));
    expect(source.spawnFailed).toHaveBeenCalledTimes(1);
    reportHarnessSpawnFailure('/bin/claude', spawnEnoent('/bin/claude'));
  });
});

describe('harnessCommandAvailable', () => {
  it('asks a source, and looks a fixed command up where spawn would', () => {
    const dir = binDir('exe-available-', ['codex']);
    expect(harnessCommandAvailable({ command: () => '/x/codex', spawnFailed: () => {} }, 'codex')).toBe(true);
    expect(
      harnessCommandAvailable(
        {
          command: () => {
            throw new HarnessExecutableUnavailableError({ harness: 'Codex', executable: 'codex' });
          },
          spawnFailed: () => {},
        },
        'codex',
      ),
    ).toBe(false);
    expect(harnessCommandAvailable(undefined, 'codex', { PATH: `/nowhere:${dir}` })).toBe(true);
    expect(harnessCommandAvailable(join(dir, 'codex'), 'codex', {})).toBe(true);
    expect(harnessCommandAvailable(undefined, 'codex', { PATH: '/nowhere' })).toBe(false);
    expect(harnessCommandAvailable(join(dir, 'missing'), 'codex', {})).toBe(false);
  });
});
