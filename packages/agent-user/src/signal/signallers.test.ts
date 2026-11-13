import { describe, expect, it } from 'vitest';

import { RecordingRunner } from '../testing/fixtures.ts';

import { AgentUserSignaller } from './agent-user-signaller.ts';
import { CompositeSignaller } from './composite-signaller.ts';
import type { ProcessSignaller } from './process-signaller.ts';
import { ServerSignaller } from './server-signaller.ts';

describe('ServerSignaller', () => {
  it('signals the negative pid: the whole group', async () => {
    const sent: [number, string][] = [];
    await new ServerSignaller((pid, signal) => void sent.push([pid, signal])).signalGroup(4242, 'SIGTERM');
    expect(sent).toEqual([[-4242, 'SIGTERM']]);
  });

  it('swallows a group that is gone or not its own', async () => {
    const signaller = new ServerSignaller(() => {
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    });
    await expect(signaller.signalGroup(4242, 'SIGKILL')).resolves.toBeUndefined();
  });

  it.each([0, 1, -5, 1.5])('never signals group %s (all of mine, init)', async group => {
    await expect(new ServerSignaller(() => {}).signalGroup(group, 'SIGTERM')).rejects.toThrow(RangeError);
  });
});

describe('AgentUserSignaller', () => {
  it('kills the group as the agent user through sudo, without a password', async () => {
    const runner = new RecordingRunner();
    await new AgentUserSignaller('factory', runner).signalGroup(4242, 'SIGTERM');
    expect(runner.calls).toEqual([['/usr/bin/sudo', '-n', '-u', 'factory', '--', '/bin/kill', '-s', 'TERM', '--', '-4242']]);
  });

  it('can stop every process of the agent user', async () => {
    const runner = new RecordingRunner();
    await new AgentUserSignaller('factory', runner).signalAll();
    expect(runner.calls).toEqual([['/usr/bin/sudo', '-n', '-u', 'factory', '--', '/bin/kill', '-s', 'KILL', '--', '-1']]);
  });

  it('never signals group 0 or 1', async () => {
    await expect(new AgentUserSignaller('factory', new RecordingRunner()).signalGroup(1, 'SIGKILL')).rejects.toThrow(RangeError);
  });
});

describe('CompositeSignaller', () => {
  it('asks every signaller, in order', async () => {
    const order: string[] = [];
    const named = (name: string): ProcessSignaller => ({ signalGroup: async () => void order.push(name) });
    await new CompositeSignaller([named('server'), named('agent')]).signalGroup(4242, 'SIGTERM');
    expect(order).toEqual(['server', 'agent']);
  });
});
