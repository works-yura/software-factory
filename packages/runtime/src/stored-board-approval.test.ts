import { describe, expect, it } from 'vitest';

import { createBoardRegistry, declarationOf, defineBoard } from '@factory/core';
import { workBoard } from '@factory/pipelines';
import { boardDefinitionOf, mergeCodeBehaviour } from '@factory/store';
import { createFactoryStorageForTests } from './test-support.ts';
import { FactoryTransitionService } from './transition-service.ts';

// From upstream `stored-board.test.ts`; it needs the transition service, which `@factory/store` cannot import.
describe('serving a stored row that fell out of step with code', () => {
  it('keeps a plan on a row missing a newer code phase waiting for approval', async () => {
    const declaration = declarationOf(workBoard)!;
    const newer = defineBoard({
      ...declaration,
      phases: {
        ...declaration.phases,
        testing: { name: 'Testing', kind: 'working', runner: { context: 'work' }, onEnter: { issue: () => undefined } },
      },
    } as Parameters<typeof defineBoard>[0]);
    const { board } = mergeCodeBehaviour(boardDefinitionOf(workBoard), newer);
    const storage = (await createFactoryStorageForTests()).workItems;
    const factoryProjectId = '11111111-2222-4333-8444-555555555555';
    const { item } = await storage.upsert({
      orgId: 'org-1',
      userId: 'user-1',
      factoryProjectId,
      input: { title: 'Fix the bug', stages: ['planning'], sessions: {}, metadata: {} },
    });
    const service = new FactoryTransitionService({
      configVersion: 'stale-row',
      storage,
      boards: createBoardRegistry({ boards: [board] }),
    });

    const moved = await service.transition({
      orgId: 'org-1',
      factoryProjectId,
      workItemId: item.id,
      board: 'work',
      stage: 'execute',
      expectedRevision: item.revision,
      actor: { type: 'agent', bindingId: 'agent', role: 'work' },
      ingress: { type: 'agent', identity: 'agent-execute' },
      cause: 'test',
    });

    expect(moved).toMatchObject({ status: 'rejected', code: 'approval_required' });
    expect((await storage.get({ orgId: 'org-1', id: item.id }))?.stages).toEqual(['planning']);
  });
});
