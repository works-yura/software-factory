import { describe, expect, it, vi } from 'vitest';

import type { FactoryStartRequest } from '@factory/harness-mastra';
import { FactoryDispatchError } from '@factory/store';
import { createFactoryStorageForTests } from '@factory/testing';

import { HarnessRoutingStartCoordinator } from './harness-start.ts';

function request(factoryProjectId: string): FactoryStartRequest {
  return {
    orgId: 'org-1',
    userId: 'user-1',
    factoryProjectId,
    sessionId: 'session-1',
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
});
