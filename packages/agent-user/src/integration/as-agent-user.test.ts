/**
 * The whole chain for real: sudo to the agent user, the environment over fd 3, the installed
 * profile. The checks SandVault runs as its sandbox user ("running as sandvault user", "HOME is
 * sandvault home", "cannot ls host home", …) plus Factory's: the card folders, the server's files,
 * stopping a group. Runs only where the system is set up (`scripts/mac-mini/isolation/2-system.sh`):
 * set FACTORY_AGENT_USER_TEST=factory; with FACTORY_AGENT_USER_TEST_STRICT=1 a missing setup fails.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { agentUserFromEnv } from '../config/from-env.ts';
import { createAgentUserLauncher } from '../launch/agent-user-launcher.ts';
import { PrivateFileStash } from '../shell/input-stash.ts';
import { ShellCommandBridge } from '../shell/shell-command-bridge.ts';
import { createProcessSpawner } from '../spawn/create-spawner.ts';

const user = process.env.FACTORY_AGENT_USER_TEST?.trim();
const sandboxRoot = process.env.FACTORY_AGENT_USER_TEST_ROOT ?? '/Volumes/dot/Project/factory/sandboxes';
const config = user ? agentUserFromEnv({ FACTORY_AGENT_USER: user }, { serverUser: process.env.USER ?? '', sandboxRoot }) : undefined;
const ready = Boolean(
  config && existsSync(config.profilePath) && spawnSync('/usr/bin/sudo', ['-n', '-u', config.user, '--', '/usr/bin/env', 'true']).status === 0,
);
if (process.env.FACTORY_AGENT_USER_TEST_STRICT === '1' && !ready) throw new Error('The agent user is not set up (sudoers rule, profile).');

async function asAgent(script: string, env: Record<string, string> = {}): Promise<{ code: number | null; out: string; err: string }> {
  const child = createProcessSpawner(config).spawn({ command: '/bin/sh', args: ['-c', script], env }, { cwd: sandboxRoot });
  let out = '';
  let err = '';
  child.stdout?.on('data', chunk => (out += chunk));
  child.stderr?.on('data', chunk => (err += chunk));
  const code = await new Promise<number | null>(resolve => child.on('close', resolve));
  return { code, out, err };
}

describe.runIf(ready)('as the agent user, for real', () => {
  it('runs as the agent user with its own HOME and PATH', async () => {
    const { out } = await asAgent('id -un; echo "$HOME"; echo "$PATH"');
    const [name, home, path] = out.trim().split('\n');
    expect(name).toBe(config?.user);
    expect(home).toBe(config?.home);
    expect(path?.startsWith(config?.toolPath[0] ?? '')).toBe(true);
    expect(out).not.toContain(homedir());
  });

  it('gets its environment intact and none of the server’s', async () => {
    const value = `it's "quoted" $HOME \`x\``;
    const { out } = await asAgent('printf %s "$TOKEN"; echo; env', { TOKEN: value });
    expect(out.split('\n')[0]).toBe(value);
    expect(out).not.toContain(`USER=${process.env.USER}\n`);
  });

  it('runs a shell bridge program (Mastra sandbox commands) as the agent, its environment off every command line', () => {
    const inputs = mkdtempSync(join(tmpdir(), 'agent-inputs-'));
    const program = new ShellCommandBridge(createAgentUserLauncher(config!), new PrivateFileStash(inputs)).commandLine('id -un; printf %s "$TOKEN"', { TOKEN: 'bridged' });
    expect(program).not.toContain('bridged');
    const result = spawnSync('/bin/sh', ['-c', program], { cwd: sandboxRoot, env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
    expect(result.stdout).toBe(`${config?.user}\nbridged`);
    expect(readdirSync(inputs)).toEqual([]);
    rmSync(inputs, { recursive: true });
  });

  it('writes in its card folders', async () => {
    expect((await asAgent('d=$(mktemp -d ./agent-test.XXXX) && echo ok > "$d/f" && cat "$d/f" && rm -r "$d"')).out.trim()).toBe('ok');
  });

  it.each([
    ['list the owner home', `ls '${homedir()}'`],
    ['read the owner .ssh', `ls '${homedir()}/.ssh'`],
    ['read the Factory database', `cat '${homedir()}/.mastracode/factory-v4/mastra.db'`],
    ['read the Claude login', `cat '${homedir()}/.claude/.credentials.json'`],
    ['list /Volumes', 'ls /Volumes'],
    ['list the projects', 'ls /Volumes/dot/Project'],
    ['write next to the card folders', 'touch /Volumes/dot/Project/factory/agent-test'],
    ['reach the Factory server', 'curl -s --max-time 3 http://127.0.0.1:5874/health'],
    ['use sudo', 'sudo -n true'],
  ])('cannot %s', async (_what, script) => {
    expect((await asAgent(script)).code).not.toBe(0);
  });

  it("uses git in a repository the server cloned (the server's own files, shared through the group ACLs)", async () => {
    const repo = mkdtempSync(join(sandboxRoot, 'agent-git-test-'));
    try {
      spawnSync('git', ['init', '-q', repo]);
      writeFileSync(join(repo, 'a.txt'), 'a');
      const { code, out, err } = await asAgent(`cd '${repo}' && git status --porcelain && echo b > b.txt && git add b.txt && git status --porcelain`);
      expect(err).not.toContain('dubious ownership');
      expect(code).toBe(0);
      expect(out).toContain('A  b.txt');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('kill stops the agent and what it started', async () => {
    const child = createProcessSpawner(config).spawn({ command: '/bin/sh', args: ['-c', 'sleep 300 & sleep 300; wait'], env: {} }, { cwd: sandboxRoot });
    await new Promise(resolve => setTimeout(resolve, 500));
    child.kill('SIGTERM');
    const code = await new Promise(resolve => child.on('close', (c, s) => resolve(c ?? s)));
    expect(code).not.toBe(0);
    const left = spawnSync('/usr/bin/pgrep', ['-u', config?.user ?? '', '-f', 'sleep 300'], { encoding: 'utf8' }).stdout.trim();
    expect(left).toBe('');
  });
});

describe('the agent-user check', () => {
  it.runIf(!ready)('is skipped: set FACTORY_AGENT_USER_TEST after scripts/mac-mini/isolation/2-system.sh agent-sudo', () => {
    expect(ready).toBe(false);
  });
});

