import { RequestContext } from '@mastra/core/request-context';
import { describe, expect, it, vi } from 'vitest';

import { bugBoard } from '@factory/pipelines';
import type { WorkItemsStorage } from '@factory/store';
import { createBoardRegistry, createFactoryStorageForTests } from '@factory/testing';

import { changedProtectedPaths } from './reproduction-test.ts';
import type { SessionGit } from './reproduction-test.ts';
import { createFactoryTransitionTools } from './tools.ts';

const PROJECT_ID = '11111111-2222-4333-8444-555555555555';
const TEST_SHA = 'c'.repeat(40);
const TEST_PATH = 'apps/mobile/test/profile_save_test.dart';

type ExecutableTool = { execute: (input: unknown, context: unknown) => Promise<unknown> };

function requestContext() {
  const context = new RequestContext();
  context.set('user', { workosId: 'user-1', organizationId: 'org-1' });
  context.set('controller', {
    resourceId: 'resource-1',
    threadId: 'thread-1',
    sessionId: 'resource-1',
    session: { id: 'session-1', ownerId: 'code', modeId: 'build' },
    getState: () => ({ factoryProjectId: PROJECT_ID }),
  });
  return context;
}

async function bindBugCard(storage: WorkItemsStorage, stage: 'tests' | 'execute', role: 'tester' | 'work', metadata = {}) {
  return storage.prepareRunStart({
    orgId: 'org-1',
    userId: 'user-1',
    factoryProjectId: PROJECT_ID,
    workItem: {
      input: {
        board: 'bug',
        title: 'Saving a profile drops the phone number',
        stages: [stage],
        externalSource: { integrationId: 'github', type: 'issue', externalId: 'github:10:issue:42' },
        metadata: { authorTrusted: true, ...metadata },
      },
    },
    role,
    session: { sessionId: 'resource-1', branch: 'factory/issue-42', threadId: 'thread-1' },
    resourceId: 'resource-1',
    kickoffKey: 'kickoff-1',
    kickoffMessage: null,
  });
}

/** A checkout whose `git diff <sha>` reports `changed` and that knows the test commit. */
function fakeGit(changed: string[], commitFiles: string[] = [TEST_PATH]): SessionGit & ReturnType<typeof vi.fn> {
  return vi.fn(async (args: readonly string[]) => {
    if (args[0] === 'diff') return { exitCode: 0, stdout: changed.join('\n') };
    if (args[0] === 'cat-file' || args[0] === 'merge-base') return { exitCode: 0, stdout: '' };
    if (args[0] === 'diff-tree') return { exitCode: 0, stdout: commitFiles.join('\n') };
    return { exitCode: 1, stdout: '', stderr: `unexpected git ${args.join(' ')}` };
  }) as never;
}

const accepted = async () => ({
  status: 'accepted' as const,
  transitionId: 'transition-1',
  itemId: 'item',
  revision: 2,
  stage: 'review',
  decisions: [],
});

describe('reproduction test guard', () => {
  const boards = createBoardRegistry({ boards: [bugBoard] });
  const recorded = { bugReproTestSha: TEST_SHA, bugReproTestPaths: [TEST_PATH] };

  it('lists protected paths changed since the test commit, renames and deletions included', async () => {
    const git = fakeGit(['lib/profile.dart', TEST_PATH]);
    expect(await changedProtectedPaths(git, TEST_SHA, [TEST_PATH, 'test/other_test.dart'])).toEqual([TEST_PATH]);
    expect(git).toHaveBeenCalledWith(['diff', '--name-only', '--no-renames', TEST_SHA, '--']);
  });

  it('rejects the fix seat moving on to Review when the checkout changes the recorded test', async () => {
    const storage = (await createFactoryStorageForTests()).workItems;
    const prepared = await bindBugCard(storage, 'execute', 'work', recorded);
    const transition = vi.fn(accepted);
    const context = requestContext();
    const git = fakeGit(['lib/profile.dart', TEST_PATH]);
    const tools = await createFactoryTransitionTools({
      requestContext: context,
      storage,
      transitionService: { transition },
      boards,
      sessionGit: async () => git,
    });
    const result = await (tools.factory_transition_work_item as ExecutableTool).execute(
      { stage: 'review', expectedRevision: prepared.item.revision, rationale: 'Fixed.' },
      { requestContext: context, agent: { toolCallId: 'call-1' } },
    );
    expect(result).toMatchObject({
      status: 'rejected',
      code: 'invalid_transition',
      reason: expect.stringContaining(TEST_PATH),
    });
    expect(transition).not.toHaveBeenCalled();
  });

  it('lets the fix seat move on when only the fix changed, and hand the card to a person regardless', async () => {
    const storage = (await createFactoryStorageForTests()).workItems;
    const prepared = await bindBugCard(storage, 'execute', 'work', recorded);
    const transition = vi.fn(accepted);
    const context = requestContext();
    const tools = await createFactoryTransitionTools({
      requestContext: context,
      storage,
      transitionService: { transition },
      boards,
      sessionGit: async () => fakeGit(['lib/profile.dart']),
    });
    const tool = tools.factory_transition_work_item as ExecutableTool;
    await tool.execute(
      { stage: 'review', expectedRevision: prepared.item.revision, rationale: 'Fixed.' },
      { requestContext: context, agent: { toolCallId: 'call-1' } },
    );
    expect(transition).toHaveBeenCalledWith(expect.objectContaining({ board: 'bug', stage: 'review' }));

    const touched = await createFactoryTransitionTools({
      requestContext: context,
      storage,
      transitionService: { transition },
      boards,
      sessionGit: async () => fakeGit([TEST_PATH]),
    });
    await (touched.factory_transition_work_item as ExecutableTool).execute(
      { stage: 'intake', expectedRevision: prepared.item.revision, rationale: 'The test looks wrong.' },
      { requestContext: context, agent: { toolCallId: 'call-2' } },
    );
    expect(transition).toHaveBeenLastCalledWith(expect.objectContaining({ stage: 'intake' }));
  });

  it('fails closed when the checkout cannot be read', async () => {
    const storage = (await createFactoryStorageForTests()).workItems;
    const prepared = await bindBugCard(storage, 'execute', 'work', recorded);
    const transition = vi.fn(accepted);
    const context = requestContext();
    const tools = await createFactoryTransitionTools({
      requestContext: context,
      storage,
      transitionService: { transition },
      boards,
    });
    expect(
      await (tools.factory_transition_work_item as ExecutableTool).execute(
        { stage: 'review', expectedRevision: prepared.item.revision, rationale: 'Fixed.' },
        { requestContext: context, agent: { toolCallId: 'call-1' } },
      ),
    ).toMatchObject({ status: 'rejected', reason: expect.stringContaining('could not be checked') });
    expect(transition).not.toHaveBeenCalled();
  });
});

describe('factory_record_reproduction_test', () => {
  const boards = createBoardRegistry({ boards: [bugBoard] });

  it('is offered only to the tester seat and records a verified test commit on the card', async () => {
    const storage = (await createFactoryStorageForTests()).workItems;
    const prepared = await bindBugCard(storage, 'tests', 'tester');
    const context = requestContext();
    const tools = await createFactoryTransitionTools({
      requestContext: context,
      storage,
      transitionService: { transition: vi.fn(accepted) },
      boards,
      sessionGit: async () => fakeGit([]),
    });
    const tool = tools.factory_record_reproduction_test as ExecutableTool;
    expect(tool).toBeDefined();
    await expect(
      tool.execute({ commitSha: TEST_SHA.toUpperCase(), testPaths: [TEST_PATH] }, { requestContext: context }),
    ).resolves.toMatchObject({ status: 'recorded', commitSha: TEST_SHA, testPaths: [TEST_PATH] });
    expect((await storage.get({ orgId: 'org-1', id: prepared.item.id }))?.metadata).toMatchObject({
      bugReproTestSha: TEST_SHA,
      bugReproTestPaths: [TEST_PATH],
    });

    const workStorage = (await createFactoryStorageForTests()).workItems;
    await bindBugCard(workStorage, 'execute', 'work');
    const workTools = await createFactoryTransitionTools({
      requestContext: context,
      storage: workStorage,
      transitionService: { transition: vi.fn(accepted) },
      boards,
    });
    expect(workTools.factory_record_reproduction_test).toBeUndefined();
  });

  it('refuses a commit that does not touch the named test files', async () => {
    const storage = (await createFactoryStorageForTests()).workItems;
    await bindBugCard(storage, 'tests', 'tester');
    const context = requestContext();
    const tools = await createFactoryTransitionTools({
      requestContext: context,
      storage,
      transitionService: { transition: vi.fn(accepted) },
      boards,
      sessionGit: async () => fakeGit([], ['lib/profile.dart']),
    });
    await expect(
      (tools.factory_record_reproduction_test as ExecutableTool).execute(
        { commitSha: TEST_SHA, testPaths: [TEST_PATH] },
        { requestContext: context },
      ),
    ).rejects.toThrow(`does not touch ${TEST_PATH}`);
  });
});
