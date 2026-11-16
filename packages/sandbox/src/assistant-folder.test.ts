import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalSandbox } from '@mastra/core/workspace';
import { describe, expect, it } from 'vitest';

import type { AgentProcesses } from './agent-processes.ts';
import { assistantFolderKey, isAssistantFolderKey } from './assistant-folder.ts';
import { LocalFactorySandbox, SANDBOX_MARKER_ENV } from './local-factory-sandbox.ts';
import { requireExec } from './materialization.ts';

describe('assistantFolderKey', () => {
  it('is assistant/<org>/<user> for plain ids', () => {
    expect(assistantFolderKey('org-1', 'user_2')).toBe('assistant/org-1/user_2');
    expect(isAssistantFolderKey('assistant/org-1/user_2')).toBe(true);
  });

  it.each([
    ['..', 'u'],
    ['o', '../x'],
    ['o/p', 'u'],
    ['', 'u'],
    ['o', ''],
    ['.hidden', 'u'],
  ])('refuses %j / %j instead of sanitizing it', (org, user) => {
    expect(() => assistantFolderKey(org, user)).toThrow(/plain path segment/);
  });

  it('tells assistant keys from session and card keys', () => {
    expect(isAssistantFolderKey('sess-1')).toBe(false);
    expect(isAssistantFolderKey('work-items/p/b')).toBe(false);
    expect(isAssistantFolderKey('assistant/o')).toBe(false);
    expect(isAssistantFolderKey('assistant/o/u/workspace')).toBe(false);
  });
});

describe('LocalFactorySandbox assistant folders', () => {
  it('roots the assistant in <root>/assistant/<org>/<user>/workspace, marked with its key', () => {
    const sandbox = new LocalFactorySandbox({ root: '/tmp/mc-sandboxes', env: { PATH: '/usr/bin' } });
    const created = sandbox.createAssistantSandbox(assistantFolderKey('org-1', 'user-1'));
    expect(created).toBeInstanceOf(LocalSandbox);
    expect(created.workingDirectory).toBe(join('/tmp/mc-sandboxes', 'assistant', 'org-1', 'user-1', 'workspace'));
    expect(created['env']).toEqual({ PATH: '/usr/bin', [SANDBOX_MARKER_ENV]: 'assistant/org-1/user-1' });
    expect(sandbox.folderKeyOf(join(created.workingDirectory, 'requests', 'r1'))).toBe('assistant/org-1/user-1');
    // Belongs to no Factory: the default isolation, Seatbelt.
    expect(sandbox.agentSeatbeltFor({ folder: created.workingDirectory })).toBe(true);
  });

  it('refuses keys that are not an assistant folder', () => {
    const sandbox = new LocalFactorySandbox({ root: '/tmp/mc-sandboxes' });
    expect(() => sandbox.createAssistantSandbox('sess-1')).toThrow(/assistant folder/);
    expect(() => sandbox.createAssistantSandbox('assistant/../x')).toThrow();
    expect(() => sandbox.assistantFolderPath('work-items/p/b')).toThrow();
  });

  it('keeps the folder when its sandbox is destroyed; removeAssistantFolder erases it and nothing else', async () => {
    const root = await mkdtemp(join(tmpdir(), 'factory-assistant-'));
    try {
      const sandbox = new LocalFactorySandbox({ root });
      const key = assistantFolderKey('org-1', 'user-1');
      const own = sandbox.createAssistantSandbox(key);
      const other = sandbox.createAssistantSandbox(assistantFolderKey('org-1', 'user-2'));
      await own.start();
      await other.start();
      const result = await requireExec(own).executeCommand('sh', ['-c', 'mkdir -p requests/r1 && printf hi > requests/r1/note.txt']);
      expect(result.exitCode).toBe(0);
      await own.destroy();
      await expect(readFile(join(own.workingDirectory, 'requests', 'r1', 'note.txt'), 'utf8')).resolves.toBe('hi');

      await writeFile(join(other.workingDirectory, 'keep.txt'), 'other');
      await sandbox.removeAssistantFolder(key);
      await expect(stat(sandbox.assistantFolderPath(key))).rejects.toThrow();
      await expect(readFile(join(other.workingDirectory, 'keep.txt'), 'utf8')).resolves.toBe('other');
      // A folder that is gone already is fine.
      await sandbox.removeAssistantFolder(key);
      await other.destroy();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('runs every command through the agent user when one is configured', async () => {
    const root = await mkdtemp(join(tmpdir(), 'factory-assistant-'));
    const lines: string[] = [];
    const agent: AgentProcesses = {
      // The real launch wraps the line in a program that runs it as the agent; here it is recorded and run as is.
      shellProgram: command => {
        lines.push(command);
        return command;
      },
      spawn: () => {
        throw new Error('not used');
      },
    };
    try {
      const sandbox = new LocalFactorySandbox({ root, agentProcesses: agent });
      const own = sandbox.createAssistantSandbox(assistantFolderKey('org-1', 'user-1'));
      await own.start();
      const result = await requireExec(own).executeCommand('echo', ['ok']);
      expect(result.stdout.trim()).toBe('ok');
      expect(lines.some(line => line.includes('echo'))).toBe(true);
      await own.destroy();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
