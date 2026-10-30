import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WorkItemsStorage } from '@factory/store';
import { createBoardRegistry, createFactoryStorageForTests } from '@factory/testing';

import { createClaudeBoundTools, createClaudeSessionTools, repositoryCheckout } from './bound-tools.ts';

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

describe('Claude Code session tools', () => {
  it("runs each tool with the session's own context and checkout sandbox, per call", async () => {
    const sandbox = { executeCommand: vi.fn() };
    const seen: unknown[] = [];
    const sourceControlTools = vi.fn(async (requestContext: { get(key: string): unknown }) => ({
      source_control_push_branch: {
        id: 'source_control_push_branch',
        description: 'Push.',
        execute: async (input: unknown, context: { requestContext: typeof requestContext; workspace?: unknown; agent?: { toolCallId: string } }) => {
          seen.push({
            input,
            sessionId: (context.requestContext.get('controller') as { sessionId: string }).sessionId,
            user: context.requestContext.get('user'),
            workspace: context.workspace,
            toolCallId: context.agent?.toolCallId,
          });
          return { pushed: true };
        },
      },
    }));
    const sandboxFor = vi.fn(async (sessionId: string) => (sessionId === scope.sessionId ? sandbox : undefined));
    const tools = await createClaudeSessionTools(scope as never, { sessionTools: sourceControlTools as never, sandboxFor });

    expect(Object.keys(tools)).toEqual(['source_control_push_branch']);
    expect(sourceControlTools).toHaveBeenCalledTimes(1);
    // Nothing is resolved until a call needs it.
    expect(sandboxFor).not.toHaveBeenCalled();
    await expect(tools.source_control_push_branch!.execute!({ repository: 'a/b' } as never, {} as never)).resolves.toEqual({ pushed: true });
    await tools.source_control_push_branch!.execute!({} as never, {} as never);
    expect(sandboxFor).toHaveBeenCalledTimes(2);
    expect(seen[0]).toEqual({
      input: { repository: 'a/b' },
      sessionId: scope.sessionId,
      user: { workosId: scope.userId, organizationId: scope.orgId },
      workspace: { sandbox },
      toolCallId: expect.any(String),
    });
    // A fresh call id each time: the inner tools key idempotency on it.
    expect((seen[1] as { toolCallId: string }).toolCallId).not.toBe((seen[0] as { toolCallId: string }).toolCallId);
  });

  it('passes no workspace when the session has no sandbox, so the tool says so', async () => {
    let workspace: unknown = 'unset';
    const tools = await createClaudeSessionTools(scope as never, {
      sessionTools: async () => ({
        source_control_push_branch: {
          id: 'source_control_push_branch',
          description: 'Push.',
          execute: async (_input: unknown, context: { workspace?: unknown }) => {
            workspace = context.workspace;
            return {};
          },
        },
      }),
      sandboxFor: async () => undefined,
    });
    await tools.source_control_push_branch!.execute!({} as never, {} as never);
    expect(workspace).toBeUndefined();
  });
});

describe('repositoryCheckout', () => {
  it('finds each repository of a session spanning several, and refuses to guess one', async () => {
    const root = mkdtempSync(join(tmpdir(), 'factory-workspace-'));
    mkdirSync(join(root, 'ai', '.git'), { recursive: true });
    mkdirSync(join(root, 'test', '.git'), { recursive: true });

    expect(repositoryCheckout(root, 'works_yura/test')).toBe(`${root}/test`);
    expect(repositoryCheckout(root, 'works_yura/missing')).toBeUndefined();
    expect(repositoryCheckout(root, undefined)).toBeUndefined();
    expect(() => repositoryCheckout(root, undefined, true)).toThrow('pass `repository`');

    // A single-repository session runs in its checkout, named or not.
    expect(repositoryCheckout(`${root}/ai`, undefined, true)).toBe(`${root}/ai`);
    expect(repositoryCheckout(`${root}/ai`, 'works_yura/ai')).toBe(`${root}/ai`);
    rmSync(root, { recursive: true, force: true });
  });
});
