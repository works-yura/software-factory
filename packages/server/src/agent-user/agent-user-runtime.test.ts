import type { ChildProcess } from 'node:child_process';

import type { ProcessSpawner } from '@factory/agent-user';
import { describe, expect, it } from 'vitest';

import { agentUserRuntimeFromEnv } from './agent-user-runtime.ts';

const sandboxRoot = '/Volumes/dot/Project/factory/sandboxes';

function recordingSpawner() {
  const calls: { spec: unknown; cwd: string }[] = [];
  const spawner: ProcessSpawner = {
    spawn: (spec, { cwd }) => {
      calls.push({ spec, cwd });
      return { pid: 1 } as unknown as ChildProcess;
    },
  };
  return { spawner, calls };
}

describe('agentUserRuntimeFromEnv', () => {
  it('is off unless FACTORY_AGENT_USER is set: agents run as the server, as before', () => {
    expect(agentUserRuntimeFromEnv({ env: {}, sandboxRoot, serverUser: 'yura', makeDirs: () => {} })).toBeUndefined();
  });

  it('puts the turn files the agent reads under the sandboxes folder and makes those folders', () => {
    const made: string[] = [];
    const runtime = agentUserRuntimeFromEnv({ env: { FACTORY_AGENT_USER: 'factory' }, sandboxRoot, serverUser: 'yura', makeDirs: dir => void made.push(dir), spawner: recordingSpawner().spawner });
    expect(runtime?.stateDir).toBe(`${sandboxRoot}/.agent-state`);
    expect(made).toEqual([`${sandboxRoot}/.agent-state`, `${sandboxRoot}/.agent-state/claude-code-config`, `${sandboxRoot}/.agent-state/tmp`]);
    const claude = runtime!.claudeCode();
    expect(claude).toMatchObject({ sessionConfigRoot: `${sandboxRoot}/.agent-state/claude-code-config`, tempDir: `${sandboxRoot}/.agent-state/tmp`, gateNode: 'node' });
  });

  it('takes its own state folder', () => {
    const runtime = agentUserRuntimeFromEnv({ env: { FACTORY_AGENT_USER: 'factory', FACTORY_AGENT_STATE_DIR: '/Volumes/dot/state' }, sandboxRoot, serverUser: 'yura', makeDirs: () => {}, spawner: recordingSpawner().spawner });
    expect(runtime?.claudeCode().tempDir).toBe('/Volumes/dot/state/tmp');
  });

  it("refuses to run agents as the server's own user", () => {
    expect(() => agentUserRuntimeFromEnv({ env: { FACTORY_AGENT_USER: 'yura' }, sandboxRoot, serverUser: 'yura', makeDirs: () => {} })).toThrow(/separate standard user/);
  });

  it('Claude turns go through the agent spawner with the harness environment and the checkout as cwd', () => {
    const { spawner, calls } = recordingSpawner();
    const runtime = agentUserRuntimeFromEnv({ env: { FACTORY_AGENT_USER: 'factory' }, sandboxRoot, serverUser: 'yura', makeDirs: () => {}, spawner });
    runtime!.claudeCode().spawn('claude', ['-p', '--output-format', 'stream-json'], {
      cwd: `${sandboxRoot}/card`,
      env: { CLAUDE_CODE_OAUTH_TOKEN: 't' },
      detached: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    expect(calls).toEqual([{ spec: { command: 'claude', args: ['-p', '--output-format', 'stream-json'], env: { CLAUDE_CODE_OAUTH_TOKEN: 't' } }, cwd: `${sandboxRoot}/card` }]);
  });
});
