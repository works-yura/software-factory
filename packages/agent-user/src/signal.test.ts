import { describe, expect, it } from 'vitest';

import type { AgentUserConfig } from './config.ts';
import { agentKillAllArgs, agentKillArgs, signalAgentGroup } from './signal.ts';

const config = { user: 'factory' } as AgentUserConfig;

describe('stopping agent processes', () => {
  it('signals the whole group as the agent user', () => {
    expect(agentKillArgs(config, 4242, 'SIGTERM')).toEqual(['-n', '-u', 'factory', '--', '/bin/kill', '-s', 'TERM', '--', '-4242']);
    expect(agentKillAllArgs(config)).toEqual(['-n', '-u', 'factory', '--', '/bin/kill', '-s', 'KILL', '--', '-1']);
  });

  it('never signals group 0 or 1 (everything of the caller, init)', () => {
    expect(() => agentKillArgs(config, 1, 'SIGTERM')).toThrow();
    expect(() => agentKillArgs(config, 0, 'SIGTERM')).toThrow();
  });

  it('runs the agent-side kill even when the server cannot reach the group', async () => {
    const calls: string[][] = [];
    await signalAgentGroup(config, 999_999_999, 'SIGKILL', async (command, args) => {
      calls.push([command, ...args]);
    });
    expect(calls).toEqual([['/usr/bin/sudo', '-n', '-u', 'factory', '--', '/bin/kill', '-s', 'KILL', '--', '-999999999']]);
  });
});
