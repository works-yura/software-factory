import { randomUUID } from 'node:crypto';

import { LibSQLFactoryStorage } from '@mastra/libsql';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { createIsolatedFactoryPostgresForTests } from '../testing.ts';
import { WorkItemsStorage } from './base.ts';
import type { Card } from './base.ts';

const postgresUrl = process.env.FACTORY_TEST_POSTGRES_URL;
const PROJECT = 'project-rename-stages';
const RENAMES = { breakdown: 'phases', 'breakdown-review': 'phases-review' };

describe.each(
  ['libsql', ...(postgresUrl ? ['postgres'] : [])].flatMap(backend =>
    ['split', 'dry-run'].map(mode => ({ backend, mode })),
  ),
)('renaming a board’s phases on its cards on $backend ($mode)', ({ backend, mode }) => {
  async function setup() {
    vi.stubEnv('MASTRA_FACTORY_WORK_ITEM_SPLIT', mode === 'dry-run' ? 'dry-run' : 'on');
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    const storage =
      backend === 'postgres'
        ? await createIsolatedFactoryPostgresForTests(postgresUrl!)
        : new LibSQLFactoryStorage({ id: `rename-stages-${randomUUID()}`, url: ':memory:' });
    const workItems = storage.registerDomain(new WorkItemsStorage());
    await storage.init();
    onTestFinished(() => storage.close());
    const orgId = `org-${randomUUID()}`;
    let next = 0;

    async function file(board: string, stages: string[]): Promise<Card> {
      next += 1;
      const { item } = await workItems.upsert({
        orgId,
        userId: 'user-1',
        factoryProjectId: PROJECT,
        input: {
          board,
          title: `Card ${next}`,
          stages: stages as Card['stages'],
          sessions: { product: { sessionId: `session-${next}`, branch: `factory/${next}`, threadId: `thread-${next}` } },
          metadata: { productChildWorkItemIds: [`child-${next}`] },
        },
      });
      return item;
    }

    const get = async (item: Card) => (await workItems.get({ orgId, id: item.id }))!;
    return { workItems, file, get };
  }

  it('moves cards in an old phase onto its new name, keeping sessions and metadata, once', async () => {
    const { workItems, file, get } = await setup();
    const breakdown = await file('product', ['breakdown']);
    const review = await file('product', ['breakdown-review']);
    const spec = await file('product', ['spec']);
    const otherBoard = await file('custom', ['breakdown']);

    const moved = await workItems.renameBoardStages('product', RENAMES);

    expect(moved.map(item => item.id).sort()).toEqual([breakdown.id, review.id].sort());
    expect((await get(breakdown)).stages).toEqual(['phases']);
    expect((await get(review)).stages).toEqual(['phases-review']);
    expect((await get(review)).revision).toBe(review.revision + 1);
    expect((await get(review)).sessions.product?.sessionId).toBe(review.sessions.product?.sessionId);
    expect((await get(review)).metadata).toMatchObject({ productChildWorkItemIds: [expect.any(String)] });
    expect((await get(spec)).stages).toEqual(['spec']);
    expect((await get(otherBoard)).stages).toEqual(['breakdown']);
    expect(await workItems.renameBoardStages('product', RENAMES)).toEqual([]);
  });

  it('does nothing without renames', async () => {
    const { workItems, file } = await setup();
    await file('product', ['breakdown']);
    expect(await workItems.renameBoardStages('product', {})).toEqual([]);
  });
});
