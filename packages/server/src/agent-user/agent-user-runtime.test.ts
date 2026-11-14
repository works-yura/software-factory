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
    const state = `${sandboxRoot}/.agent-state`;
    expect(made).toEqual([state, `${state}/claude-code-config`, `${state}/tmp`, `${state}/codex-home`, `${state}/claude-code-supervisor`, `${state}/codex-supervisor`]);
    const claude = runtime!.claudeCode();
    expect(claude).toMatchObject({
      command: 'claude',
      sessionConfigRoot: `${state}/claude-code-config`,
      supervisorWorkdirRoot: `${state}/claude-code-supervisor`,
      tempDir: `${state}/tmp`,
      gateNode: 'node',
    });
    expect(runtime!.codex()).toMatchObject({ command: 'codex', sessionHomeRoot: `${state}/codex-home`, supervisorWorkdirRoot: `${state}/codex-supervisor` });
  });

  it("never runs the server user's configured claude: the agent cannot reach it", () => {
    const runtime = agentUserRuntimeFromEnv({ env: { FACTORY_AGENT_USER: 'factory', FACTORY_CLAUDE_CODE_COMMAND: '/Users/yura/.local/bin/claude' }, sandboxRoot, serverUser: 'yura', makeDirs: () => {}, spawner: recordingSpawner().spawner });
    expect(runtime?.claudeCode().command).toBe('claude');
    const pinned = agentUserRuntimeFromEnv({ env: { FACTORY_AGENT_USER: 'factory', FACTORY_AGENT_CLAUDE_COMMAND: '/Users/factory/.local/bin/claude' }, sandboxRoot, serverUser: 'yura', makeDirs: () => {}, spawner: recordingSpawner().spawner });
    expect(pinned?.claudeCode().command).toBe('/Users/factory/.local/bin/claude');
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

  it("Codex runs the agent's own codex unless FACTORY_AGENT_CODEX_COMMAND names one", () => {
    const runtime = agentUserRuntimeFromEnv({ env: { FACTORY_AGENT_USER: 'factory', FACTORY_CODEX_COMMAND: '/Users/yura/.nvm/bin/codex' }, sandboxRoot, serverUser: 'yura', makeDirs: () => {}, spawner: recordingSpawner().spawner });
    expect(runtime?.codex().command).toBe('codex');
    const pinned = agentUserRuntimeFromEnv({ env: { FACTORY_AGENT_USER: 'factory', FACTORY_AGENT_CODEX_COMMAND: '/Users/factory/.local/node/bin/codex' }, sandboxRoot, serverUser: 'yura', makeDirs: () => {}, spawner: recordingSpawner().spawner });
    expect(pinned?.codex().command).toBe('/Users/factory/.local/node/bin/codex');
  });

  it('Codex goes through the agent spawner without the Seatbelt profile: it sandboxes its own commands, and macOS cannot nest sandboxes', () => {
    const { spawner, calls } = recordingSpawner();
    const runtime = agentUserRuntimeFromEnv({ env: { FACTORY_AGENT_USER: 'factory' }, sandboxRoot, serverUser: 'yura', makeDirs: () => {}, spawner });
    runtime!.codex().spawn('codex', ['app-server'], { cwd: `${sandboxRoot}/card`, env: { CODEX_HOME: '/h' } });
    expect(calls).toEqual([{ spec: { command: 'codex', args: ['app-server'], env: { CODEX_HOME: '/h' }, seatbelt: false }, cwd: `${sandboxRoot}/card` }]);
  });

  it('sandbox commands: a shell program as the agent (no value on its line), and spawns through the agent spawner', () => {
    const { spawner, calls } = recordingSpawner();
    const runtime = agentUserRuntimeFromEnv({ env: { FACTORY_AGENT_USER: 'factory' }, sandboxRoot, serverUser: 'yura', makeDirs: () => {}, spawner, inputDir: '/tmp/never-written' });
    runtime!.processes.spawn('pnpm', ['install'], { cwd: `${sandboxRoot}/t`, env: { A: '1' } });
    expect(calls).toEqual([{ spec: { command: 'pnpm', args: ['install'], env: { A: '1' } }, cwd: `${sandboxRoot}/t` }]);
  });
});
