import { RequestContext } from '@mastra/core/request-context';
import { describe, expect, it, vi } from 'vitest';

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
        board: 'work',
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
  const boards = createBoardRegistry();
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
    expect(transition).toHaveBeenCalledWith(expect.objectContaining({ board: 'work', stage: 'review' }));

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
  const boards = createBoardRegistry();

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

describe('reproduction tests across repositories', () => {
  const boards = createBoardRegistry();
  const API_SHA = 'a'.repeat(40);
  const APP_SHA = 'b'.repeat(40);
  const API_TEST = 'test/orders.test.ts';
  const APP_TEST = 'lib/orders_test.dart';

  it('records one test per repository and asks for the repository when the card names none', async () => {
    const storage = (await createFactoryStorageForTests()).workItems;
    const prepared = await bindBugCard(storage, 'tests', 'tester');
    const context = requestContext();
    const asked: Array<{ repository?: string; requireRepository?: boolean }> = [];
    const checkouts: Record<string, SessionGit> = {
      'acme/api': fakeGit([], [API_TEST]),
      'acme/app': fakeGit([], [APP_TEST]),
    };
    const tools = await createFactoryTransitionTools({
      requestContext: context,
      storage,
      transitionService: { transition: vi.fn(accepted) },
      boards,
      sessionGit: async ({ repository, requireRepository }) => {
        asked.push({ repository, requireRepository });
        if (!repository) throw new Error('This session spans several repositories; pass `repository`.');
        return checkouts[repository];
      },
    });
    const tool = tools.factory_record_reproduction_test as ExecutableTool;

    // The card names no repository, so the tester must say where the test went.
    await expect(tool.execute({ commitSha: API_SHA, testPaths: [API_TEST] }, { requestContext: context })).rejects.toThrow(
      'pass `repository`',
    );
    expect(asked[0]).toEqual({ repository: undefined, requireRepository: true });

    await tool.execute({ commitSha: API_SHA, testPaths: [API_TEST], repository: 'acme/api' }, { requestContext: context });
    await tool.execute({ commitSha: APP_SHA, testPaths: [APP_TEST], repository: 'acme/app' }, { requestContext: context });

    expect((await storage.get({ orgId: 'org-1', id: prepared.item.id }))?.metadata).toMatchObject({
      reproductionTests: [
        { repository: 'acme/api', sha: API_SHA, paths: [API_TEST] },
        { repository: 'acme/app', sha: APP_SHA, paths: [APP_TEST] },
      ],
      // The board policy reads the first record.
      bugReproTestSha: API_SHA,
      bugReproTestPaths: [API_TEST],
    });

    // Re-recording a repository replaces its own record only.
    const newer = 'd'.repeat(40);
    await tool.execute({ commitSha: newer, testPaths: [APP_TEST], repository: 'acme/app' }, { requestContext: context });
    expect((await storage.get({ orgId: 'org-1', id: prepared.item.id }))?.metadata?.reproductionTests).toEqual([
      { repository: 'acme/api', sha: API_SHA, paths: [API_TEST] },
      { repository: 'acme/app', sha: newer, paths: [APP_TEST] },
    ]);
  });

  it("checks every repository's recorded test in that repository's checkout before the fix seat moves on", async () => {
    const storage = (await createFactoryStorageForTests()).workItems;
    const prepared = await bindBugCard(storage, 'execute', 'work', {
      reproductionTests: [
        { repository: 'acme/api', sha: API_SHA, paths: [API_TEST] },
        { repository: 'acme/app', sha: APP_SHA, paths: [APP_TEST] },
      ],
      bugReproTestSha: API_SHA,
      bugReproTestPaths: [API_TEST],
    });
    const transition = vi.fn(accepted);
    const context = requestContext();
    const changedIn: Record<string, string[]> = { 'acme/api': ['src/orders.ts'], 'acme/app': [APP_TEST] };
    const tools = await createFactoryTransitionTools({
      requestContext: context,
      storage,
      transitionService: { transition },
      boards,
      sessionGit: async ({ repository }) => fakeGit(changedIn[repository!] ?? []),
    });
    const move = () =>
      (tools.factory_transition_work_item as ExecutableTool).execute(
        { stage: 'review', expectedRevision: prepared.item.revision, rationale: 'Fixed.' },
        { requestContext: context, agent: { toolCallId: 'call-1' } },
      );

    // The app's test changed: the move is refused and names that repository.
    await expect(move()).resolves.toMatchObject({
      status: 'rejected',
      reason: expect.stringContaining(`committed at ${APP_SHA} in acme/app`),
    });
    expect(transition).not.toHaveBeenCalled();

    changedIn['acme/app'] = ['lib/orders.dart'];
    await move();
    expect(transition).toHaveBeenCalledWith(expect.objectContaining({ stage: 'review' }));
  });
});
