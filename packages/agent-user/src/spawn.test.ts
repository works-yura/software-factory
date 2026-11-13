import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import type { AgentUserConfig } from './config.ts';
import { spawnAsAgent } from './spawn.ts';

const config: AgentUserConfig = {
  user: 'factory',
  home: '/Users/factory',
  profilePath: '/var/factory/agent-factory.sb',
  writableRoots: ['/w'],
  toolPath: [],
};

function fakeSpawn() {
  const calls: { command: string; args: string[]; options: Record<string, unknown> }[] = [];
  let fd3 = '';
  const spawn = ((command: string, args: string[], options: Record<string, unknown>) => {
    calls.push({ command, args, options });
    const envPipe = new PassThrough();
    envPipe.on('data', chunk => (fd3 += chunk));
    const child = Object.assign(new EventEmitter(), {
      pid: 4242,
      exitCode: null,
      signalCode: null,
      stdio: [new PassThrough(), new PassThrough(), new PassThrough(), envPipe],
      kill: () => true,
    });
    return child;
  }) as never;
  return { spawn, calls, fd3: () => fd3 };
}

describe('spawnAsAgent', () => {
  it('spawns sudo detached in the card folder and writes the environment to fd 3', () => {
    const fake = fakeSpawn();
    spawnAsAgent(config, '/bin/claude', ['-p'], { TOKEN: 'secret' }, { cwd: '/w/card', spawn: fake.spawn });
    expect(fake.calls[0]?.command).toBe('/usr/bin/sudo');
    expect(fake.calls[0]?.options).toMatchObject({ cwd: '/w/card', detached: true, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
    expect(fake.fd3()).toContain("export TOKEN='secret'");
  });

  it('kill reaches the agent user’s processes in the group', async () => {
    const fake = fakeSpawn();
    const kills: string[][] = [];
    const child = spawnAsAgent(config, '/bin/claude', [], {}, { cwd: '/w', spawn: fake.spawn, runKill: async (c, a) => void kills.push([c, ...a]) });
    expect(child.kill('SIGTERM')).toBe(true);
    await new Promise(resolve => setImmediate(resolve));
    expect(kills).toEqual([['/usr/bin/sudo', '-n', '-u', 'factory', '--', '/bin/kill', '-s', 'TERM', '--', '-4242']]);
  });
});
