import { LibSQLFactoryStorage } from '@mastra/libsql';
import { describe, expect, it, vi } from 'vitest';

import { deleteSessionRecord } from './session-deletion.ts';
import type { SourceControlSession } from './source-control/base.ts';
import { WorkItemsStorage } from './work-items/base.ts';

const session: Pick<SourceControlSession, 'id' | 'orgId' | 'sessionId'> = {
  id: 'row-1',
  orgId: 'org1',
  sessionId: 'session-1',
};

async function boundCard() {
  const backend = new LibSQLFactoryStorage({ id: 'session-deletion-test', url: ':memory:' });
  const workItems = backend.registerDomain(new WorkItemsStorage());
  await backend.init();
  const started = await workItems.prepareRunStart({
    orgId: 'org1',
    userId: 'user1',
    factoryProjectId: 'project1',
    workItem: {
      input: {
        externalSource: { integrationId: 'github', type: 'issue', externalId: '42' },
        title: 'Fix login',
        stages: ['intake'],
        sessions: {},
        metadata: {},
      },
    },
    role: 'work',
    session: { sessionId: session.sessionId, branch: 'factory/42', threadId: session.sessionId },
    resourceId: 'resource-1',
    kickoffKey: 'kickoff-1',
    kickoffMessage: null,
  });
  return { workItems, started };
}

describe('deleteSessionRecord', () => {
  it("deletes the row only after the cards let go of the session and its bindings are revoked", async () => {
    const { workItems, started } = await boundCard();
    const order: string[] = [];
    const sourceControl = {
      sessions: {
        delete: vi.fn(async (id: string) => {
          const bindings = await workItems.listRunBindings('org1', 'project1', started.item.id);
          const card = await workItems.get({ orgId: 'org1', id: started.item.id });
          order.push(`delete ${id}: bindings ${bindings.map(b => b.status).join(',')}, refs ${Object.keys(card!.sessions).length}`);
        }),
      },
    } as never;

    await deleteSessionRecord({ sourceControl, workItems }, session);

    expect(order).toEqual(['delete row-1: bindings revoked, refs 0']);
  });

  it('keeps the row when the cards could not let go, so deleting again finishes the job', async () => {
    const remove = vi.fn(async () => {});
    const workItems = { clearSessionReferences: vi.fn(async () => Promise.reject(new Error('database down'))) };

    await expect(deleteSessionRecord({ sourceControl: { sessions: { delete: remove } } as never, workItems }, session)).rejects.toThrow(
      'database down',
    );
    expect(remove).not.toHaveBeenCalled();
  });

  it('deletes the row of a server without work items', async () => {
    const remove = vi.fn(async () => {});
    await deleteSessionRecord({ sourceControl: { sessions: { delete: remove } } as never }, session);
    expect(remove).toHaveBeenCalledWith('row-1');
  });
});
