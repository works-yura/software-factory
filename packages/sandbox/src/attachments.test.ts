import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { LocalSandbox } from '@mastra/core/workspace';
import type { WorkspaceSandbox } from '@mastra/core/workspace';
import { afterEach, describe, expect, it, onTestFinished } from 'vitest';

import { materializeSessionAttachments } from './attachments.ts';
import { __clearSessionSandboxesForTests, getSessionSandbox } from './session-sandbox.ts';

const exec = promisify(execFile);

async function workspaceWithRepo(name = 'repo') {
  const root = await mkdtemp(join(tmpdir(), 'factory-attachments-sandbox-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, name);
  await mkdir(repo);
  await exec('git', ['init', '-q'], { cwd: repo });
  return { root, repo };
}

function attachment(sandboxPath: string, text: string, opened: { count: number } = { count: 0 }) {
  const bytes = new TextEncoder().encode(text);
  return {
    sandboxPath,
    size: bytes.length,
    open: async () => {
      opened.count += 1;
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      });
    },
  };
}

/** A non-local sandbox whose commands run on this host: exercises the remote write path for real. */
function hostShellSandbox(id: string, workingDirectory: string): WorkspaceSandbox {
  return {
    id,
    name: id,
    provider: 'test-remote',
    status: 'running',
    workingDirectory,
    executeCommand: async (command: string, args: string[] = [], options: { cwd?: string } = {}) => {
      try {
        const { stdout, stderr } = await exec(command, args, { cwd: options.cwd ?? workingDirectory, maxBuffer: 1 << 24 });
        return { exitCode: 0, stdout, stderr, success: true, executionTimeMs: 0 };
      } catch (error) {
        const failed = error as { code?: number; stdout?: string; stderr?: string };
        return { exitCode: failed.code ?? 1, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '', success: false, executionTimeMs: 0 };
      }
    },
  } as unknown as WorkspaceSandbox;
}

afterEach(() => __clearSessionSandboxesForTests());

describe('materializeSessionAttachments', () => {
  it('places files in the checkout under .factory and keeps .factory out of git', async () => {
    const { root, repo } = await workspaceWithRepo();
    getSessionSandbox('session-1', 'acme/repo', () => new LocalSandbox({ id: 'session-1', workingDirectory: root }));
    const opened = { count: 0 };
    const files = [attachment('.factory/attachments/1a2b3c4d-brief.md', '# Бриф', opened)];

    const first = await materializeSessionAttachments({ sessionId: 'session-1', attachments: files });
    expect(first.root).toBe(repo);
    expect(first.written).toEqual([join(repo, '.factory/attachments/1a2b3c4d-brief.md')]);
    expect(await readFile(first.written[0]!, 'utf8')).toBe('# Бриф');
    expect(await readFile(join(repo, '.git/info/exclude'), 'utf8')).toMatch(/^\.factory\/$/m);
    const { stdout } = await exec('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: repo });
    expect(stdout).toBe('');

    // A second call finds the file in place and the exclude line already written.
    const second = await materializeSessionAttachments({ sessionId: 'session-1', attachments: files });
    expect(second.written).toEqual([]);
    expect(opened.count).toBe(1);
    const exclude = await readFile(join(repo, '.git/info/exclude'), 'utf8');
    expect(exclude.match(/^\.factory\/$/gm)).toHaveLength(1);
  });

  it('writes through the command channel on a remote sandbox', async () => {
    const { root, repo } = await workspaceWithRepo();
    getSessionSandbox('session-2', 'acme/repo', () => hostShellSandbox('session-2', root));
    const big = 'x'.repeat(48 * 1024 * 2 + 17);
    const result = await materializeSessionAttachments({
      sessionId: 'session-2',
      attachments: [attachment('.factory/attachments/abcdef12-big.txt', big)],
    });
    expect(result.written).toEqual([join(repo, '.factory/attachments/abcdef12-big.txt')]);
    expect(await readFile(result.written[0]!, 'utf8')).toBe(big);
    expect(await readFile(join(repo, '.git/info/exclude'), 'utf8')).toMatch(/^\.factory\/$/m);
  });

  it('rewrites a file whose size is wrong', async () => {
    const { root, repo } = await workspaceWithRepo();
    getSessionSandbox('session-3', 'acme/repo', () => new LocalSandbox({ id: 'session-3', workingDirectory: root }));
    await mkdir(join(repo, '.factory/attachments'), { recursive: true });
    await writeFile(join(repo, '.factory/attachments/1a2b3c4d-a.txt'), 'partial');
    const result = await materializeSessionAttachments({
      sessionId: 'session-3',
      attachments: [attachment('.factory/attachments/1a2b3c4d-a.txt', 'the whole file')],
    });
    expect(result.written).toHaveLength(1);
    expect(await readFile(join(repo, '.factory/attachments/1a2b3c4d-a.txt'), 'utf8')).toBe('the whole file');
  });

  it('refuses paths outside .factory/attachments and sessions without a sandbox', async () => {
    const { root } = await workspaceWithRepo();
    getSessionSandbox('session-4', 'acme/repo', () => new LocalSandbox({ id: 'session-4', workingDirectory: root }));
    await expect(
      materializeSessionAttachments({ sessionId: 'session-4', attachments: [attachment('.factory/attachments/../../x', 'x')] }),
    ).rejects.toThrow(/Refusing/);
    await expect(
      materializeSessionAttachments({ sessionId: 'session-4', attachments: [attachment('src/x.txt', 'x')] }),
    ).rejects.toThrow(/Refusing/);
    await expect(materializeSessionAttachments({ sessionId: 'nobody', attachments: [] })).rejects.toThrow(/no sandbox/);
  });
});
