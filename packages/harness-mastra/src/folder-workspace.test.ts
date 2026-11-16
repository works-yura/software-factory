import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkspaceTools, LocalSandbox } from '@mastra/core/workspace';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createFolderFilesystem, createFolderWorkspace, folderWorkspaceTools, workspaceToolApproval } from './folder-workspace.ts';

type Executable = { execute: (input: unknown, context?: unknown) => Promise<unknown> };

describe('folder workspace', () => {
  let root: string;
  let sandbox: LocalSandbox;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'folder-ws-'));
    sandbox = new LocalSandbox({ id: 'folder-test', workingDirectory: join(root, 'workspace') });
    await sandbox.start();
  });
  afterEach(async () => {
    await sandbox.destroy();
    await rm(root, { recursive: true, force: true });
  });

  it("gives the agent Mastra Code's workspace tools under the sessions' names", async () => {
    const filesystem = createFolderFilesystem({ id: 'ws', sandbox, workdir: sandbox.workingDirectory });
    const workspace = createFolderWorkspace({ id: 'ws', name: 'test', sandbox, filesystem });
    const tools = await createWorkspaceTools(workspace);
    expect(Object.keys(tools)).toEqual(
      expect.arrayContaining(['view', 'find_files', 'search_content', 'write_file', 'string_replace_lsp', 'execute_command']),
    );
  });

  it('reads and writes inside the folder and refuses paths that leave it', async () => {
    const filesystem = createFolderFilesystem({ id: 'ws', sandbox, workdir: sandbox.workingDirectory, verifySymlinks: true });
    await filesystem.writeFile('/requests/r1/a.txt', 'hello');
    await expect(readFile(join(sandbox.workingDirectory, 'requests', 'r1', 'a.txt'), 'utf8')).resolves.toBe('hello');
    await expect(filesystem.readFile('/../outside.txt')).rejects.toThrow();
    await writeFile(join(root, 'secret.txt'), 'secret');
    await symlink(join(root, 'secret.txt'), join(sandbox.workingDirectory, 'link.txt'));
    await expect(filesystem.readFile('/link.txt')).rejects.toThrow();
  });

  it('runs hooks after its own: a refusal stops the call with its output', async () => {
    const seen: string[] = [];
    const filesystem = createFolderFilesystem({ id: 'ws', sandbox, workdir: sandbox.workingDirectory });
    const workspace = createFolderWorkspace({
      id: 'ws',
      name: 'test',
      sandbox,
      filesystem,
      hooks: {
        beforeToolCall: ({ toolName }) => {
          seen.push(toolName);
          return toolName === 'execute_command' ? { proceed: false, output: 'needs approval' } : undefined;
        },
      },
    });
    const tools = (await createWorkspaceTools(workspace)) as unknown as Record<string, Executable>;
    await expect(tools.execute_command!.execute({ command: 'touch ran.txt', description: 'touch' }, {})).resolves.toBe('needs approval');
    await expect(readFile(join(sandbox.workingDirectory, 'ran.txt'))).rejects.toThrow();
    expect(seen).toEqual(['execute_command']);
    expect(folderWorkspaceTools().hooks).toBeDefined();
  });

  it("answers approvals with the sessions' default rules: reads run, edits and commands ask", () => {
    expect(workspaceToolApproval('view')).toBe('allow');
    expect(workspaceToolApproval('find_files')).toBe('allow');
    expect(workspaceToolApproval('search_content')).toBe('allow');
    expect(workspaceToolApproval('write_file')).toBe('ask');
    expect(workspaceToolApproval('string_replace_lsp')).toBe('ask');
    expect(workspaceToolApproval('execute_command')).toBe('ask');
    expect(workspaceToolApproval('execute_command', { categories: { execute: 'deny' }, tools: {} })).toBe('deny');
  });
});
