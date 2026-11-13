import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { agentProfile, sbplString } from './profile.ts';

describe('agentProfile', () => {
  it('escapes paths for SBPL and refuses ones it cannot hold', () => {
    expect(sbplString('/a "b"\\c')).toBe('"/a \\"b\\"\\\\c"');
    expect(() => sbplString('/a\nb')).toThrow();
  });

  it('lets the agent look up the folders above its card folders, nothing more', () => {
    const profile = agentProfile({ home: '/Users/factory', writableRoots: ['/Volumes/dot/Project/factory/sandboxes'] });
    expect(profile).toContain('(literal "/Volumes/dot/Project/factory")');
    expect(profile).toContain('(subpath "/Volumes/dot/Project/factory/sandboxes")');
    expect(profile).not.toContain('(subpath "/Volumes/dot/Project")');
    expect(profile).toContain('(remote ip "localhost:5874")');
  });
});

// The profile under the real sandbox-exec: the card folder is writable, its neighbour on the same
// disk is not, other homes are unreadable. Runs where sandbox-exec exists (macOS).
const hasSandboxExec = spawnSync('/usr/bin/sandbox-exec', ['-n', 'no-network', '/usr/bin/true']).status === 0;

describe.runIf(hasSandboxExec)('agentProfile under sandbox-exec', () => {
  // Not under the temp folders, which the profile allows writing anyway.
  const base = mkdtempSync(join(process.cwd(), '.profile-test-'));
  const card = join(base, 'sandboxes', 'card');
  const neighbour = join(base, 'eclipt-ai');
  const home = mkdtempSync(join(tmpdir(), 'agent-home-'));
  mkdirSync(card, { recursive: true });
  mkdirSync(neighbour, { recursive: true });
  writeFileSync(join(neighbour, 'secret.txt'), 'secret');
  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });
  const profile = agentProfile({ home, writableRoots: [join(base, 'sandboxes')] });
  const run = (script: string) => spawnSync('/usr/bin/sandbox-exec', ['-p', profile, '/bin/sh', '-c', script], { encoding: 'utf8' });

  it('writes in the card folder', () => {
    expect(run(`echo ok > '${card}/f' && cat '${card}/f'`).stdout.trim()).toBe('ok');
  });

  it('neither reads nor writes the folder next to it', () => {
    expect(run(`cat '${neighbour}/secret.txt'`).status).not.toBe(0);
    expect(run(`echo x > '${neighbour}/new'`).status).not.toBe(0);
  });

  it("cannot read another user's home", () => {
    expect(run(`ls '${homedir()}'`).status).not.toBe(0);
  });
});
