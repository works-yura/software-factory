import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeFactorySandbox, LocalSandbox } from '@mastra/core/workspace';
import { describe, expect, it } from 'vitest';
import { LocalFactorySandbox } from './local-factory-sandbox.ts';

describe('LocalFactorySandbox', () => {
  it('roots each session under root/sessionId with the configured env', () => {
    const sandbox = new LocalFactorySandbox({ root: '/tmp/mc-sandboxes', env: { PATH: '/usr/bin' } });
    expect(describeFactorySandbox(sandbox)).toMatchObject({
      provider: 'local',
      capabilities: { template: false, builds: { available: false, history: false } },
    });
    const created = sandbox.create({ sessionId: 'sess-1', getRepositoryAccess: undefined });
    expect(created).toBeInstanceOf(LocalSandbox);
    expect(created.id).toBe('sess-1');
    expect(created.workingDirectory).toBe(join('/tmp/mc-sandboxes', 'sess-1'));
    expect(created['env']).toEqual({ PATH: '/usr/bin' });
  });

  it("roots every session of a card in the card's folder", () => {
    const sandbox = new LocalFactorySandbox({ root: '/tmp/mc-sandboxes' });
    const folder = 'work-items/project-1/factory-issue-42-abc';
    const triage = sandbox.create({ sessionId: 'sess-triage', workItemFolder: folder, getRepositoryAccess: undefined });
    const work = sandbox.create({ sessionId: 'sess-work', workItemFolder: folder, getRepositoryAccess: undefined });

    expect(triage.id).toBe('sess-triage');
    expect(triage.workingDirectory).toBe(join('/tmp/mc-sandboxes', 'work-items', 'project-1', 'factory-issue-42-abc'));
    expect(work.workingDirectory).toBe(triage.workingDirectory);
  });

  it("stops a destroyed card session but keeps the card's folder, which goes only with removeWorkItemFolder", async () => {
    const root = await mkdtemp(join(tmpdir(), 'factory-local-'));
    try {
      const sandbox = new LocalFactorySandbox({ root });
      const folder = 'work-items/project-1/factory-item-1';
      const shared = sandbox.create({ sessionId: 'sess-triage', workItemFolder: folder, getRepositoryAccess: undefined });
      const own = sandbox.create({ sessionId: 'sess-chat', getRepositoryAccess: undefined });
      await shared.start();
      await own.start();
      await writeFile(join(shared.workingDirectory, 'plan.md'), 'plan');
      await writeFile(join(own.workingDirectory, 'notes.md'), 'notes');

      await shared.destroy();
      await own.destroy();

      await expect(readFile(join(shared.workingDirectory, 'plan.md'), 'utf8')).resolves.toBe('plan');
      await expect(readFile(join(own.workingDirectory, 'notes.md'), 'utf8')).rejects.toThrow();
      await sandbox.removeWorkItemFolder(folder);
      await expect(readFile(join(shared.workingDirectory, 'plan.md'), 'utf8')).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("moves the first starting session's own old folder into its card's new folder, and leaves the rest to retirement", async () => {
    const root = await mkdtemp(join(tmpdir(), 'factory-local-'));
    try {
      const sandbox = new LocalFactorySandbox({ root });
      const folder = 'work-items/project-1/factory-item-1';
      for (const [sessionId, file] of [
        ['sess-triage', 'findings.md'],
        ['sess-work', 'plan.md'],
      ] as const) {
        await mkdir(join(root, sessionId, 'repo'), { recursive: true });
        await writeFile(join(root, sessionId, 'repo', file), sessionId);
      }
      const triage = sandbox.create({ sessionId: 'sess-triage', workItemFolder: folder, getRepositoryAccess: undefined });
      const work = sandbox.create({ sessionId: 'sess-work', workItemFolder: folder, getRepositoryAccess: undefined });

      await triage.start();
      await work.start();

      await expect(readFile(join(triage.workingDirectory, 'repo', 'findings.md'), 'utf8')).resolves.toBe('sess-triage');
      // The old path leads to the card folder, for a Claude Code session that recorded it as its cwd.
      expect(await realpath(join(root, 'sess-triage'))).toBe(await realpath(triage.workingDirectory));
      await sandbox.removeLegacySessionFolder('sess-triage');
      await expect(readFile(join(triage.workingDirectory, 'repo', 'findings.md'), 'utf8')).resolves.toBe('sess-triage');
      // The card folder already existed for work: its old folder stays where it was.
      await expect(readFile(join(root, 'sess-work', 'repo', 'plan.md'), 'utf8')).resolves.toBe('sess-work');
      await sandbox.removeLegacySessionFolder('sess-work');
      await expect(readFile(join(root, 'sess-work', 'repo', 'plan.md'), 'utf8')).rejects.toThrow();
      await expect(readFile(join(work.workingDirectory, 'repo', 'findings.md'), 'utf8')).resolves.toBe('sess-triage');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses a card folder outside work-items/ under the root', () => {
    const sandbox = new LocalFactorySandbox({ root: '/tmp/mc-sandboxes' });
    for (const folder of ['sess-1', 'work-items', 'work-items/../../etc', 'work-items//x']) {
      expect(() => sandbox.create({ sessionId: 's', workItemFolder: folder, getRepositoryAccess: undefined }), folder).toThrow(
        /Refusing/,
      );
    }
  });
});
