import type { RequestContext } from '@mastra/core/request-context';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import { boardForWorkItem, REPRODUCTION_TEST_PATHS_KEY, REPRODUCTION_TEST_SHA_KEY } from '@factory/core';
import type { BoardRegistry } from '@factory/core';
import type { IntegrationTools } from '@factory/integrations';
import { WorkItemUpdateConflictError } from '@factory/store';
import type { WorkItemRow, WorkItemsStorage } from '@factory/store';
import type { FactorySessionSourceLookup } from '@factory/session';
import { resolveFactorySessionAddress } from '@factory/session';

/**
 * Runs git in the active session's own checkout. The host builds it from the session's sandbox and
 * repository; boards without a reproduction test never call it.
 */
export type SessionGit = (args: readonly string[]) => Promise<{ exitCode: number; stdout: string; stderr?: string }>;

/** Resolves the session checkout's git for one tool execution; undefined when the session has none. */
export type SessionGitResolver = (execution: {
  requestContext?: RequestContext;
  workspace?: unknown;
}) => Promise<SessionGit | undefined>;

type ReproductionPhases = { record: string; protect: string; recordRole: string; protectRole: string };

function reproductionPhases(boards: BoardRegistry | undefined, item: WorkItemRow): ReproductionPhases | undefined {
  const board = boards?.get(boardForWorkItem(item));
  const declared = board?.reproductionTest;
  if (!board || !declared) return undefined;
  return {
    ...declared,
    recordRole: board.roleForPhase(declared.record)!,
    protectRole: board.roleForPhase(declared.protect)!,
  };
}

/** Whether `role` is the seat that records the reproduction test on the card's board. */
export function recordsReproductionTest(boards: BoardRegistry | undefined, item: WorkItemRow, role: string): boolean {
  return reproductionPhases(boards, item)?.recordRole === role;
}

function recordedTest(item: WorkItemRow): { sha: string; paths: string[] } | undefined {
  const sha = item.metadata?.[REPRODUCTION_TEST_SHA_KEY];
  const paths = item.metadata?.[REPRODUCTION_TEST_PATHS_KEY];
  if (typeof sha !== 'string' || !Array.isArray(paths)) return undefined;
  const strings = paths.filter((path): path is string => typeof path === 'string');
  return strings.length > 0 ? { sha, paths: strings } : undefined;
}

function lines(stdout: string): string[] {
  return stdout
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
}

/** Protected test paths the checkout changes since `sha`: commits, staged and unstaged edits, deletions, renames. */
export async function changedProtectedPaths(git: SessionGit, sha: string, paths: readonly string[]): Promise<string[]> {
  const diff = await git(['diff', '--name-only', '--no-renames', sha, '--']);
  if (diff.exitCode !== 0) throw new Error(`git diff against ${sha} failed: ${diff.stderr?.trim() || diff.stdout.trim()}`);
  const changed = new Set(lines(diff.stdout));
  return paths.filter(path => changed.has(path));
}

/**
 * The deterministic half of the reproduction-test contract: the seat fixing the code cannot move
 * the card on to another working phase while its checkout changes the recorded test files.
 * Returns a rejection for the transition tool to answer with, or undefined to let the transition
 * service decide. Moves to resting or terminal phases (handing the card to a person) pass.
 */
export async function reproductionTestGuard(input: {
  boards: BoardRegistry | undefined;
  item: WorkItemRow;
  role: string;
  stage: string;
  git: () => Promise<SessionGit | undefined>;
}): Promise<{ status: 'rejected'; code: 'invalid_transition'; reason: string } | undefined> {
  const phases = reproductionPhases(input.boards, input.item);
  const board = input.boards?.get(boardForWorkItem(input.item));
  if (!phases || !board) return undefined;
  if (input.item.stages.length !== 1 || input.item.stages[0] !== phases.protect) return undefined;
  if (input.role !== phases.protectRole || input.stage === phases.protect || !board.isWorking(input.stage)) return undefined;
  const recorded = recordedTest(input.item);
  if (!recorded) return undefined;
  const reject = (reason: string) => ({ status: 'rejected' as const, code: 'invalid_transition' as const, reason });
  let changed: string[];
  try {
    const git = await input.git();
    if (!git) return reject('The reproduction test could not be checked: this session has no repository checkout.');
    changed = await changedProtectedPaths(git, recorded.sha, recorded.paths);
  } catch (error) {
    return reject(
      `The reproduction test could not be checked: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (changed.length === 0) return undefined;
  return reject(
    `The reproduction test committed at ${recorded.sha} must stay as written, but this checkout changes ` +
      `${changed.join(', ')}. Restore those files (git checkout ${recorded.sha} -- <path>), commit, push, and ` +
      'request the move again. If the test itself is wrong, move the card to `intake` for a person.',
  );
}

const testPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine(path => !path.startsWith('/') && !path.split('/').includes('..'), 'Use a path relative to the repository root.');

const recordInputSchema = z
  .object({
    commitSha: z
      .string()
      .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i, 'Use the full SHA of the commit that added the failing test.'),
    testPaths: z.array(testPathSchema).min(1).max(50).describe('The test files that commit added or changed.'),
  })
  .strict();

/**
 * `factory_record_reproduction_test`: the tester records the commit that adds the failing test and
 * the test files it wrote. The commit must exist in the checkout, be part of HEAD, and touch every
 * named file; the board's policy lets the card into the fix phase only once this is recorded.
 */
export function createReproductionTestTool(
  options: {
    storage: WorkItemsStorage;
    boards?: BoardRegistry;
    sessions?: FactorySessionSourceLookup;
    sessionGit?: SessionGitResolver;
  },
  boundWorkItemId: string,
): IntegrationTools {
  return {
    factory_record_reproduction_test: createTool({
      id: 'factory_record_reproduction_test',
      description:
        'Record the commit that adds the failing reproduction test, and the test files it wrote, on the card bound to this thread. Call it after the test is committed and pushed and fails for the reason the plan predicts. The fix phase may not change these files afterwards.',
      inputSchema: recordInputSchema,
      requireApproval: false,
      execute: async ({ commitSha, testPaths }, execution) => {
        const resolution = await resolveFactorySessionAddress({
          requestContext: execution.requestContext as RequestContext,
          storage: options.storage,
          sessions: options.sessions,
        });
        const binding = resolution ? await options.storage.findActiveRunBinding(resolution.address) : null;
        if (!binding || binding.workItemId !== boundWorkItemId) {
          throw new Error('Factory tester binding is unavailable, revoked, or no longer matches this session.');
        }
        const item = await options.storage.get({ orgId: binding.orgId, id: binding.workItemId });
        if (!item) throw new Error('Bound Factory work item not found.');
        const phases = reproductionPhases(options.boards, item);
        if (!phases || binding.role !== phases.recordRole || item.stages[0] !== phases.record) {
          throw new Error(`Only the ${phases?.recordRole ?? 'tester'} seat records a reproduction test, in its own phase.`);
        }
        const git = await options.sessionGit?.({
          requestContext: execution.requestContext as RequestContext,
          workspace: (execution as { workspace?: unknown }).workspace,
        });
        if (!git) throw new Error('Recording a reproduction test needs this session’s repository checkout.');
        const sha = commitSha.toLowerCase();
        if ((await git(['cat-file', '-e', `${sha}^{commit}`])).exitCode !== 0) {
          throw new Error(`Commit ${sha} is not in this checkout. Commit and push the test first.`);
        }
        if ((await git(['merge-base', '--is-ancestor', sha, 'HEAD'])).exitCode !== 0) {
          throw new Error(`Commit ${sha} is not part of the checked-out branch.`);
        }
        const touched = await git(['diff-tree', '--no-commit-id', '--name-only', '--no-renames', '-r', '--root', sha]);
        if (touched.exitCode !== 0) throw new Error(`Could not read the files of commit ${sha}.`);
        const files = new Set(lines(touched.stdout));
        const paths = [...new Set(testPaths)];
        const missing = paths.filter(path => !files.has(path));
        if (missing.length > 0) {
          throw new Error(`Commit ${sha} does not touch ${missing.join(', ')}. Name the test files that commit wrote.`);
        }
        const recordedAt = new Date().toISOString();
        try {
          await options.storage.update({
            orgId: binding.orgId,
            id: item.id,
            userId: `agent:${binding.id}`,
            expectedRevision: item.revision,
            patch: {
              metadata: {
                ...(item.metadata ?? {}),
                [REPRODUCTION_TEST_SHA_KEY]: sha,
                [REPRODUCTION_TEST_PATHS_KEY]: paths,
                bugReproTestRecordedAt: recordedAt,
              },
            },
          });
        } catch (error) {
          if (!(error instanceof WorkItemUpdateConflictError)) throw error;
          throw new Error('The card changed while recording the test; call again to record it on the current card.');
        }
        return { status: 'recorded', commitSha: sha, testPaths: paths, recordedAt };
      },
    }),
  };
}
