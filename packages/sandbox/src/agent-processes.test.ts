import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LocalSandbox } from '@mastra/core/workspace';
import { describe, expect, it } from 'vitest';

import type { AgentProcesses } from './agent-processes.ts';
import { runProcessesAsAgent } from './local-factory-sandbox.ts';
import { hostExecutor } from './template/host-exec.ts';

const scratch = () => mkdtempSync(join(tmpdir(), 'agent-processes-'));

function recordingAgent() {
  const programs: Array<{ command: string; env: Record<string, string | undefined> }> = [];
  const spawns: Array<{ command: string; args: readonly string[]; cwd: string; env: Record<string, string | undefined> }> = [];
  const agent: AgentProcesses = {
    shellProgram: (command, env) => {
      programs.push({ command, env });
      return `echo as-agent; ${command}`;
    },
    spawn: (command, args, { cwd, env }) => {
      spawns.push({ command, args, cwd, env });
      return spawn(command, [...args], { cwd, env: env as NodeJS.ProcessEnv, stdio: 'pipe', detached: true });
    },
  };
  return { agent, programs, spawns };
}

describe('runProcessesAsAgent', () => {
  it("runs every sandbox command through the agent's program, with the environment the sandbox would give it", async () => {
    const { agent, programs } = recordingAgent();
    const sandbox = new LocalSandbox({ workingDirectory: scratch(), env: { BASE: 'b' } });
    runProcessesAsAgent(sandbox, agent);
    const result = await sandbox.executeCommand!('echo', ['hi there'], { env: { EXTRA: 'e' } });
    expect(result.stdout).toBe('as-agent\nhi there\n');
    expect(programs).toHaveLength(1);
    expect(programs[0]!.command).toBe("echo 'hi there'");
    expect(programs[0]!.env).toMatchObject({ BASE: 'b', EXTRA: 'e' });
  });

  it('refuses a sandbox that already has its own isolation', () => {
    const sandbox = new LocalSandbox({ workingDirectory: scratch(), isolation: 'seatbelt' });
    expect(() => runProcessesAsAgent(sandbox, recordingAgent().agent)).toThrow(/no other isolation/);
  });
});

describe('hostExecutor with an agent', () => {
  it("starts the command through the agent's spawn with the host environment and the command's cwd", async () => {
    const { agent, spawns } = recordingAgent();
    const cwd = scratch();
    const result = await hostExecutor({ env: { BASE: 'b' }, agent }).executeCommand('/bin/sh', ['-c', 'printf %s "$BASE"'], { cwd, env: { DROP: undefined } });
    expect(result).toMatchObject({ exitCode: 0, stdout: 'b' });
    expect(spawns[0]).toMatchObject({ command: '/bin/sh', cwd, env: { BASE: 'b', GIT_TERMINAL_PROMPT: '0' } });
  });

  it("stops a command past its timeout through the agent's kill", async () => {
    const { agent } = recordingAgent();
    const killed: string[] = [];
    const killing: AgentProcesses = {
      ...agent,
      spawn: (command, args, options) => {
        const child = agent.spawn(command, args, options);
        const own = child.kill.bind(child);
        child.kill = signal => (killed.push(String(signal)), own(signal));
        return child;
      },
    };
    const result = await hostExecutor({ agent: killing }).executeCommand('/bin/sleep', ['5'], { timeout: 100 });
    expect(result.exitCode).toBe(124);
    expect(killed).toEqual(['SIGKILL']);
  });
});
