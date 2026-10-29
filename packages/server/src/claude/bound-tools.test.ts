import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WorkItemsStorage } from '@factory/store';
import { createBoardRegistry, createFactoryStorageForTests } from '@factory/testing';

import { createClaudeBoundTools } from './bound-tools.ts';

const PROJECT_ID = '11111111-2222-4333-8444-555555555555';
const TEST_PATH = 'test/profile_test.js';
const scope = {
  orgId: 'org-1',
  factoryProjectId: PROJECT_ID,
  userId: 'user-1',
  sessionId: 'resource-1',
  resourceId: 'resource-1',
  threadId: 'thread-1',
  kind: 'worker' as const,
  interactive: false,
};

type ExecutableTool = { execute: (input: unknown, context?: unknown) => Promise<unknown> };

const checkouts: string[] = [];
afterEach(() => {
  for (const dir of checkouts.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** A real checkout with one commit that adds the failing test. */
function checkoutWithTestCommit(): { cwd: string; sha: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'factory-claude-checkout-'));
  checkouts.push(cwd);
  git(cwd, 'init', '-q', '-b', 'main');
  git(cwd, 'config', 'user.email', 'factory@example.test');
  git(cwd, 'config', 'user.name', 'Factory');
  writeFileSync(join(cwd, 'profile.js'), 'export const save = p => ({ name: p.name });\n');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-q', '-m', 'initial');
  mkdirSync(join(cwd, 'test'));
  writeFileSync(join(cwd, TEST_PATH), "assert(save({ phone: '1' }).phone === '1');\n");
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-q', '-m', 'test: reproduce dropped phone');
  return { cwd, sha: git(cwd, 'rev-parse', 'HEAD') };
}

async function bindCard(storage: WorkItemsStorage, stage: 'tests' | 'execute', role: 'tester' | 'work', metadata = {}) {
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

const accepted = async () => ({
  status: 'accepted' as const,
  transitionId: 'transition-1',
  itemId: 'item',
  revision: 2,
  stage: 'review',
  decisions: [],
});

describe('Claude Code bound tools: failing tests in the session checkout', () => {
  const boards = createBoardRegistry();

  it("records the tester's commit from the session's own checkout", async () => {
    const { cwd, sha } = checkoutWithTestCommit();
    const storage = (await createFactoryStorageForTests()).workItems;
    const prepared = await bindCard(storage, 'tests', 'tester');
    const tools = await createClaudeBoundTools(scope, {
      storage,
      transitionService: { transition: vi.fn(accepted) },
      boards,
      checkoutFor: async sessionId => (sessionId === scope.sessionId ? cwd : undefined),
    });
    await expect(
      (tools.factory_record_reproduction_test as ExecutableTool).execute({ commitSha: sha, testPaths: [TEST_PATH] }),
    ).resolves.toMatchObject({ status: 'recorded', commitSha: sha, testPaths: [TEST_PATH] });
    expect((await storage.get({ orgId: 'org-1', id: prepared.item.id }))?.metadata).toMatchObject({
      bugReproTestSha: sha,
      bugReproTestPaths: [TEST_PATH],
    });
  });

  it('keeps the builder from leaving Building after it edits the recorded test, and lets a real fix through', async () => {
    const { cwd, sha } = checkoutWithTestCommit();
    const storage = (await createFactoryStorageForTests()).workItems;
    const prepared = await bindCard(storage, 'execute', 'work', { bugReproTestSha: sha, bugReproTestPaths: [TEST_PATH] });
    const transition = vi.fn(accepted);
    const tools = await createClaudeBoundTools(scope, {
      storage,
      transitionService: { transition },
      boards,
      checkoutFor: async () => cwd,
    });
    const move = () =>
      (tools.factory_transition_work_item as ExecutableTool).execute({
        stage: 'review',
        expectedRevision: prepared.item.revision,
        rationale: 'Fixed.',
      });

    // Weakening the test, even uncommitted, is caught.
    writeFileSync(join(cwd, TEST_PATH), 'assert(true);\n');
    await expect(move()).resolves.toMatchObject({ status: 'rejected', reason: expect.stringContaining(TEST_PATH) });
    expect(transition).not.toHaveBeenCalled();

    // Restoring the test and fixing the code passes.
    git(cwd, 'checkout', sha, '--', TEST_PATH);
    writeFileSync(join(cwd, 'profile.js'), 'export const save = p => ({ name: p.name, phone: p.phone });\n');
    git(cwd, 'commit', '-qam', 'fix: keep the phone number');
    await move();
    expect(transition).toHaveBeenCalledWith(expect.objectContaining({ board: 'work', stage: 'review' }));
  });

  it('fails closed without a checkout, as before', async () => {
    const storage = (await createFactoryStorageForTests()).workItems;
    const prepared = await bindCard(storage, 'execute', 'work', { bugReproTestSha: 'c'.repeat(40), bugReproTestPaths: [TEST_PATH] });
    const transition = vi.fn(accepted);
    const tools = await createClaudeBoundTools(scope, { storage, transitionService: { transition }, boards });
    await expect(
      (tools.factory_transition_work_item as ExecutableTool).execute({
        stage: 'review',
        expectedRevision: prepared.item.revision,
        rationale: 'Fixed.',
      }),
    ).resolves.toMatchObject({ status: 'rejected', reason: expect.stringContaining('could not be checked') });
    expect(transition).not.toHaveBeenCalled();
  });
});
