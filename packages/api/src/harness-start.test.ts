import { describe, expect, it, vi } from 'vitest';

import type { FactoryStartRequest } from '@factory/harness-mastra';
import { FactoryDispatchError } from '@factory/store';
import { createFactoryStorageForTests } from '@factory/testing';

import { HarnessRoutingStartCoordinator } from './harness-start.ts';

function request(factoryProjectId: string, sessionId = 'session-1'): FactoryStartRequest {
  return {
    orgId: 'org-1',
    userId: 'user-1',
    factoryProjectId,
    sessionId,
    threadTitle: 'Card',
    kickoffKey: 'kickoff-1',
    workItem: { role: 'triage', input: { title: 'Card', stages: ['intake'] } },
  };
}

describe('HarnessRoutingStartCoordinator', () => {
  it('starts a factory on the harness it was created with', async () => {
    const seeded = await createFactoryStorageForTests();
    const mastra = await seeded.projects.create({ orgId: 'org-1', userId: 'user-1', input: { name: 'M' } });
    const claude = await seeded.projects.create({
      orgId: 'org-1',
      userId: 'user-1',
      input: { name: 'C', harness: 'claude-code' },
    });
    expect(mastra.harness).toBe('mastra');
    const claudePrepare = vi.fn(async () => ({ sessionId: 'session-1' }) as never);
    // A Mastra start reaches the Mastra controller, which this stub refuses.
    const controller = { queryThreadById: vi.fn(), createSession: vi.fn() };
    const coordinator = new HarnessRoutingStartCoordinator(
      [controller as never, seeded.workItems, undefined, undefined],
      { projects: seeded.projects, coordinators: { 'claude-code': { prepare: claudePrepare } } },
    );

    await expect(coordinator.prepare(request(claude.id))).resolves.toEqual({ sessionId: 'session-1' });
    expect(claudePrepare).toHaveBeenCalledTimes(1);

    await expect(coordinator.prepare(request(mastra.id))).rejects.toThrow('source control storage is unavailable');
    expect(claudePrepare).toHaveBeenCalledTimes(1);
  });

  it('refuses a factory whose harness this server has not configured', async () => {
    const seeded = await createFactoryStorageForTests();
    const claude = await seeded.projects.create({
      orgId: 'org-1',
      userId: 'user-1',
      input: { name: 'C', harness: 'claude-code' },
    });
    const coordinator = new HarnessRoutingStartCoordinator([{} as never, seeded.workItems], {
      projects: seeded.projects,
      coordinators: {},
    });
    await expect(coordinator.prepare(request(claude.id))).rejects.toBeInstanceOf(FactoryDispatchError);
  });

  describe('after the Factory switched harness', () => {
    async function setup() {
      const seeded = await createFactoryStorageForTests();
      const project = await seeded.projects.create({ orgId: 'org-1', userId: 'user-1', input: { name: 'F' } });
      const claudeSessions = new Set<string>();
      const mastraThreads = new Set<string>();
      const claudePrepare = vi.fn(async (req: FactoryStartRequest) => ({ sessionId: req.sessionId }) as never);
      const controller = {
        queryThreadById: vi.fn(async ({ threadId }: { threadId: string }) =>
          mastraThreads.has(threadId) ? { id: threadId, resourceId: project.id } : null,
        ),
        createSession: vi.fn(),
      };
      const coordinator = new HarnessRoutingStartCoordinator(
        [controller as never, seeded.workItems, undefined, undefined],
        {
          projects: seeded.projects,
          coordinators: {
            'claude-code': { prepare: claudePrepare, owns: async sessionId => claudeSessions.has(sessionId) },
          },
        },
      );
      const switchTo = (harness: 'mastra' | 'claude-code') =>
        seeded.projects.update({ orgId: 'org-1', id: project.id, input: { harness } });
      // The Mastra path is stubbed out: reaching it fails on the missing source control.
      const MASTRA = 'source control storage is unavailable';
      return { project, claudeSessions, mastraThreads, claudePrepare, coordinator, switchTo, MASTRA };
    }

    it('Mastra → Claude Code: a running Mastra card stays on Mastra, a new card starts on Claude Code', async () => {
      const { project, mastraThreads, claudePrepare, coordinator, switchTo, MASTRA } = await setup();
      mastraThreads.add('running');
      await switchTo('claude-code');

      await expect(coordinator.prepare(request(project.id, 'running'))).rejects.toThrow(MASTRA);
      expect(claudePrepare).not.toHaveBeenCalled();

      await expect(coordinator.prepare(request(project.id, 'fresh'))).resolves.toEqual({ sessionId: 'fresh' });
      expect(claudePrepare).toHaveBeenCalledTimes(1);
    });

    it('Claude Code → Mastra: a running Claude card stays on Claude Code, a new card starts on Mastra', async () => {
      const { project, claudeSessions, claudePrepare, coordinator, switchTo, MASTRA } = await setup();
      await switchTo('claude-code');
      claudeSessions.add('running');
      await switchTo('mastra');

      await expect(coordinator.prepare(request(project.id, 'running'))).resolves.toEqual({ sessionId: 'running' });
      expect(claudePrepare).toHaveBeenCalledTimes(1);

      await expect(coordinator.prepare(request(project.id, 'fresh'))).rejects.toThrow(MASTRA);
      expect(claudePrepare).toHaveBeenCalledTimes(1);
    });

    it('asks Claude Code first, so a Mastra thread for the same id does not steal a Claude session', async () => {
      const { project, claudeSessions, mastraThreads, claudePrepare, coordinator } = await setup();
      claudeSessions.add('both');
      mastraThreads.add('both');
      await coordinator.prepare(request(project.id, 'both'));
      expect(claudePrepare).toHaveBeenCalledTimes(1);
    });
  });
});
