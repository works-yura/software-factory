import { randomUUID } from 'node:crypto';

import { LibSQLFactoryStorage } from '@mastra/libsql';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { createIsolatedFactoryPostgresForTests } from '../testing.ts';
import { WorkItemsStorage } from './base.ts';
import type { Card } from './base.ts';

const postgresUrl = process.env.FACTORY_TEST_POSTGRES_URL;
const PROJECT = 'project-review-retirement';

describe.each(
  ['libsql', ...(postgresUrl ? ['postgres'] : [])].flatMap(backend =>
    ['split', 'dry-run'].map(mode => ({ backend, mode })),
  ),
)('moving Review board cards to Work on $backend ($mode)', ({ backend, mode }) => {
  async function setup() {
    vi.stubEnv('MASTRA_FACTORY_WORK_ITEM_SPLIT', mode === 'dry-run' ? 'dry-run' : 'on');
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    const storage =
      backend === 'postgres'
        ? await createIsolatedFactoryPostgresForTests(postgresUrl!)
        : new LibSQLFactoryStorage({ id: `review-retirement-${randomUUID()}`, url: ':memory:' });
    const workItems = storage.registerDomain(new WorkItemsStorage());
    await storage.init();
    onTestFinished(() => storage.close());
    const orgId = `org-${randomUUID()}`;
    let next = 0;

    async function file({
      board,
      type,
      stages,
      metadata = {},
    }: {
      board?: string;
      type: 'issue' | 'pull-request';
      stages: string[];
      metadata?: Record<string, unknown>;
    }): Promise<Card> {
      next += 1;
      const { item } = await workItems.upsert({
        orgId,
        userId: 'user-1',
        factoryProjectId: PROJECT,
        input: {
          ...(board ? { board } : {}),
          externalSource: { integrationId: 'github', type, externalId: `${orgId}-${next}` },
          title: `Card ${next}`,
          stages: stages as Card['stages'],
          sessions: { review: { sessionId: `session-${next}`, branch: `factory/${next}`, threadId: `thread-${next}` } },
          metadata,
        },
      });
      return item;
    }

    const get = async (item: Card) => (await workItems.get({ orgId, id: item.id }))!;
    return { workItems, file, get };
  }

  it('files Review cards and legacy pull request cards on Work, Reviewing as PR review', async () => {
    const { workItems, file, get } = await setup();
    const reviewing = await file({
      board: 'review',
      type: 'pull-request',
      stages: ['review'],
      metadata: { reviewVerdict: 'approve' },
    });
    const done = await file({ board: 'review', type: 'pull-request', stages: ['done'] });
    const legacy = await file({ type: 'pull-request', stages: ['review'] });
    const legacyIssue = await file({ type: 'issue', stages: ['execute'] });
    const work = await file({ board: 'work', type: 'pull-request', stages: ['pr-review'] });

    const moved = await workItems.moveReviewBoardCardsToWork();

    expect(moved.map(item => item.id).sort()).toEqual([reviewing.id, done.id, legacy.id].sort());
    const after = await get(reviewing);
    expect(after).toMatchObject({
      board: 'work',
      stages: ['pr-review'],
      revision: reviewing.revision + 1,
      metadata: expect.objectContaining({ reviewVerdict: 'approve' }),
      sessions: { review: expect.objectContaining({ sessionId: reviewing.sessions.review!.sessionId }) },
    });
    // History keeps its entries, renamed to the phase the card now sits in.
    expect(after.stageHistory.map(entry => entry.stage)).toEqual(['pr-review']);
    expect(await get(done)).toMatchObject({ board: 'work', stages: ['done'] });
    expect(await get(legacy)).toMatchObject({ board: 'work', stages: ['pr-review'] });
    // A legacy issue card already reads as Work, and a Work card is where it belongs.
    expect(await get(legacyIssue)).toMatchObject({ board: null, revision: legacyIssue.revision });
    expect(await get(work)).toMatchObject({ board: 'work', revision: work.revision });

    expect(await workItems.moveReviewBoardCardsToWork()).toEqual([]);
  });
});
