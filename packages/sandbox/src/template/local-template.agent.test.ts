import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { AgentProcesses } from '../agent-processes.ts';

import { LocalEnvironmentTemplate } from './local-template.ts';
import { mirrorsOf } from './test-git.ts';

describe('LocalEnvironmentTemplate with an agent user', () => {
  const roots: string[] = [];
  afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

  it("starts the agent's mirror git in the template root, never the server's own folder", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'template-agent-')));
    roots.push(root);
    const cwds: string[] = [];
    const agentProcesses: AgentProcesses = {
      shellProgram: () => {
        throw new Error('not used');
      },
      spawn: (command, args, options) => {
        cwds.push(options.cwd);
        return spawn(command, [...args], { cwd: options.cwd, env: options.env as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'] });
      },
    };
    const template = new LocalEnvironmentTemplate({ root, agentProcesses, env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } });

    await mirrorsOf(template).ensureExists({ cloneUrl: 'https://github.com/example/repo.git' });

    expect(cwds.length).toBeGreaterThan(0);
    expect(cwds.every(cwd => cwd === root)).toBe(true);
    expect(cwds).not.toContain(process.cwd());
  });
});
