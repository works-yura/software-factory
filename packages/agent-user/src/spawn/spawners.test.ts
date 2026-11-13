import { describe, expect, it } from 'vitest';

import { agentConfig, fakeSpawn, RecordingRunner } from '../testing/fixtures.ts';

import { createProcessSpawner } from './create-spawner.ts';

describe('createProcessSpawner', () => {
  it('without an agent user, runs the command itself, detached, with its environment', () => {
    const fake = fakeSpawn();
    createProcessSpawner(undefined, { spawn: fake.spawn }).spawn({ command: '/bin/claude', args: ['-p'], env: { A: '1' } }, { cwd: '/w' });
    expect(fake.calls[0]).toMatchObject({ command: '/bin/claude', args: ['-p'], options: { cwd: '/w', env: { A: '1' }, detached: true, stdio: ['pipe', 'pipe', 'pipe'] } });
  });

  it('with an agent user, spawns sudo in the card folder and writes the environment to fd 3', () => {
    const fake = fakeSpawn();
    createProcessSpawner(agentConfig, { spawn: fake.spawn, runner: new RecordingRunner() }).spawn(
      { command: '/bin/claude', args: [], env: { TOKEN: 'secret' } },
      { cwd: '/Volumes/dot/Project/factory/sandboxes/card' },
    );
    const call = fake.calls[0];
    expect(call?.command).toBe('/usr/bin/sudo');
    expect(call?.options).toMatchObject({ cwd: '/Volumes/dot/Project/factory/sandboxes/card', detached: true, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
    expect(call?.args.join(' ')).not.toContain('secret');
    expect(fake.written[3]).toContain("export TOKEN='secret'");
  });

  it("kill stops the whole group, as the server and as the agent user", async () => {
    const fake = fakeSpawn(5151);
    const runner = new RecordingRunner();
    const child = createProcessSpawner(agentConfig, { spawn: fake.spawn, runner }).spawn({ command: '/bin/claude', args: [], env: {} }, { cwd: '/w' });
    expect(child.kill('SIGTERM')).toBe(true);
    await new Promise(resolve => setImmediate(resolve));
    expect(runner.calls).toEqual([['/usr/bin/sudo', '-n', '-u', 'factory', '--', '/bin/kill', '-s', 'TERM', '--', '-5151']]);
  });

  it('kill of a process that already ended does not signal anyone', () => {
    const fake = fakeSpawn();
    const runner = new RecordingRunner();
    const child = createProcessSpawner(agentConfig, { spawn: fake.spawn, runner }).spawn({ command: '/bin/x', args: [], env: {} }, { cwd: '/w' });
    Object.assign(child, { exitCode: 0 });
    child.kill('SIGTERM');
    expect(runner.calls).toEqual([]);
  });
});

describe('LaunchingSpawner edge cases', () => {
  it('a numeric signal becomes SIGTERM for the group', async () => {
    const fake = fakeSpawn(6161);
    const runner = new RecordingRunner();
    const child = createProcessSpawner(agentConfig, { spawn: fake.spawn, runner }).spawn({ command: '/bin/x', args: [], env: {} }, { cwd: '/w' });
    child.kill(9);
    await new Promise(resolve => setImmediate(resolve));
    expect(runner.calls[0]?.slice(-3)).toEqual(['TERM', '--', '-6161']);
  });

  it('a process that dies before reading its environment does not crash the server', () => {
    const fake = fakeSpawn();
    const child = createProcessSpawner(agentConfig, { spawn: fake.spawn, runner: new RecordingRunner() }).spawn({ command: '/bin/x', args: [], env: {} }, { cwd: '/w' });
    expect(() => (child.stdio[3] as import('node:stream').Writable).emit('error', new Error('EPIPE'))).not.toThrow();
  });
});
