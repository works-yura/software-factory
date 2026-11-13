/**
 * The agent profile under the real sandbox-exec, as the current user: the escape checks SandVault
 * runs in its sandbox (`scripts/tests`, "assert_sandbox_fails"), adapted to Factory's layout (card
 * folders on a data disk). The separate user is the other layer; `as-agent-user.test.ts` checks both.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { SeatbeltAgentPolicy } from './agent-policy.ts';

const hasSandboxExec = spawnSync('/usr/bin/sandbox-exec', ['-n', 'no-network', '/usr/bin/true']).status === 0;

describe.runIf(hasSandboxExec)('agent profile under sandbox-exec', () => {
  // On the package's disk, not under the temp folders the profile allows anyway.
  const base = mkdtempSync(join(process.cwd(), '.sandbox-test-'));
  const sandboxes = join(base, 'sandboxes');
  const card = join(sandboxes, 'card');
  const neighbour = join(base, 'neighbour');
  const home = mkdtempSync(join(tmpdir(), 'agent-home-'));
  mkdirSync(card, { recursive: true });
  mkdirSync(neighbour, { recursive: true });
  writeFileSync(join(neighbour, 'secret.txt'), 'secret');
  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  const profile = new SeatbeltAgentPolicy({ home, writableRoots: [sandboxes] }).render();
  const run = (script: string) => spawnSync('/usr/bin/sandbox-exec', ['-p', profile, '/bin/sh', '-c', script], { encoding: 'utf8', timeout: 20_000 });
  const ok = (what: string, script: string) => it(`can ${what}`, () => expect(run(script).status, run(script).stderr).toBe(0));
  const fails = (what: string, script: string) => it(`cannot ${what}`, () => expect(run(script).status).not.toBe(0));
  const q = (path: string) => `'${path.replace(/'/g, `'\\''`)}'`;

  ok('run a command', 'echo hello');
  ok('write and read in its card folder', `echo ok > ${q(card)}/f && test "$(cat ${q(card)}/f)" = ok`);
  ok('make folders in its card folder', `mkdir -p ${q(card)}/a/b/c`);
  ok('cd into its card folder through the folders above it', `cd ${q(card)} && pwd`);
  ok('write in its home', `echo ok > ${q(home)}/f`);
  ok('write in /tmp and to /dev/null', 'echo ok > /tmp/agent-profile-test.$$ && rm /tmp/agent-profile-test.$$ && echo x > /dev/null');
  ok('read system files', 'cat /etc/hosts > /dev/null && ls /usr/bin > /dev/null');
  ok('read the public CA roots', 'test -r /Library/Keychains/System.keychain && head -c 1 /Library/Keychains/System.keychain > /dev/null');
  ok('list processes with ps', 'ps -A > /dev/null');

  fails('read the folder next to its card folder', `cat ${q(neighbour)}/secret.txt`);
  fails('write the folder next to its card folder', `echo x > ${q(neighbour)}/new`);
  fails('list the folder above its card folders', `ls ${q(base)}`);
  fails('list /Volumes', 'ls /Volumes');
  fails('list /Users', 'ls /Users');
  fails("list another user's home", `ls ${q(homedir())}`);
  fails("read another user's shell config", `cat ${q(join(homedir(), '.zshrc'))} || cat ${q(join(homedir(), '.zprofile'))}`);
  fails("list another user's .ssh", `ls ${q(join(homedir(), '.ssh'))}`);
  fails("read another user's keychains", `ls ${q(join(homedir(), 'Library', 'Keychains'))}`);
  fails('write outside its folders (/Users/Shared)', 'echo x > /Users/Shared/agent-profile-test');
  fails('write /Applications', 'touch /Applications/agent-profile-test');
  fails('write /usr/local', 'touch /usr/local/agent-profile-test');
  fails('write /opt/homebrew', 'touch /opt/homebrew/agent-profile-test');
  fails('read a raw disk', 'head -c 1 /dev/rdisk0');
  fails('mount a disk image', 'hdiutil attach -nomount /nonexistent.dmg');

  it.runIf(existsSync('/usr/bin/curl'))('cannot reach the Factory server port', () => {
    // Fails either way when nothing listens; the point is that a listening server is not reachable.
    const probe = spawnSync('/usr/bin/curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '3', 'http://127.0.0.1:5874/health'], { encoding: 'utf8' });
    const sandboxed = run("/usr/bin/curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:5874/health");
    if (probe.stdout === '200') expect(sandboxed.stdout).not.toBe('200');
    expect(sandboxed.status).not.toBe(0);
  });
});
