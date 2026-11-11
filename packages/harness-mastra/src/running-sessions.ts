// Moves a Factory's running Mastra runs onto a model: every active run binding whose card is short of
// a terminal phase gets the model on its thread, which the run picks up at its next start. What the
// Mastra facet's `applyDefaultToRunningSessions` does after Settings sets a new default.
import { workItemPhaseSemantics } from '@factory/core';
import type { RunningSessionsApplyResult } from '@factory/harness/models/facet';
import { createDefaultBoardRegistry } from '@factory/pipelines';
import type { ProjectBoardCache } from '@factory/runtime';
import type { WorkItemsStorage } from '@factory/store';

/** The session gateway the bound threads are reached through. */
export interface BoundThreadController {
  getSession: (sessionId: string) => Promise<BoundThreadSession | undefined | null>;
}

interface BoundThreadSession {
  thread: {
    getById: (args: { threadId: string }) => Promise<{ metadata?: Record<string, unknown> | null } | null>;
    setSettingOn: (args: { threadId: string; key: string; value: unknown }) => Promise<unknown> | unknown;
  };
}

export type BoundThreadSkipReason = 'not-running' | 'work-item-missing' | 'stage-inactive' | 'thread-missing' | 'apply-failed';

export interface RunningSessionsDependencies {
  workItems: Pick<WorkItemsStorage, 'listRunBindings' | 'get'>;
  /** The project's boards, to tell a card's phase; the code boards when absent. */
  boards?: () => Pick<ProjectBoardCache, 'describe'> | undefined;
}

export async function applyModelToBoundThreads(
  deps: RunningSessionsDependencies & { controller: BoundThreadController },
  input: {
    orgId: string;
    factoryProjectId: string;
    modelId: string;
    /** False once the Factory's default moved on: stop before writing this model to another thread. */
    stillCurrent?: () => Promise<boolean>;
  },
): Promise<RunningSessionsApplyResult & { skipped: Array<{ threadId: string; reason: BoundThreadSkipReason }> }> {
  const { workItems, controller } = deps;
  const bindings = (await workItems.listRunBindings(input.orgId, input.factoryProjectId)).filter(
    binding => binding.status === 'active',
  );
  const boards =
    (await deps.boards?.()?.describe({ orgId: input.orgId, factoryProjectId: input.factoryProjectId }))?.registry ??
    createDefaultBoardRegistry();
  const seen = new Set<string>();
  const applied: string[] = [];
  const skipped: Array<{ threadId: string; reason: BoundThreadSkipReason }> = [];

  for (const binding of bindings) {
    // A default changed while this job was queued or running must not be written by this job.
    if (input.stillCurrent && !(await input.stillCurrent())) break;
    const key = `${binding.sessionId}:${binding.threadId}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const item = await workItems.get({ orgId: input.orgId, id: binding.workItemId });
    if (!item || item.factoryProjectId !== input.factoryProjectId) {
      skipped.push({ threadId: binding.threadId, reason: 'work-item-missing' });
      continue;
    }
    // A bound run can still act on its card anywhere short of a terminal phase.
    const phaseKind = workItemPhaseSemantics(boards, item)?.kind;
    if (phaseKind === undefined || phaseKind === 'terminal') {
      skipped.push({ threadId: binding.threadId, reason: 'stage-inactive' });
      continue;
    }
    const session = await controller.getSession(binding.sessionId);
    if (!session) {
      skipped.push({ threadId: binding.threadId, reason: 'not-running' });
      continue;
    }
    const thread = await session.thread.getById({ threadId: binding.threadId });
    if (!thread) {
      skipped.push({ threadId: binding.threadId, reason: 'thread-missing' });
      continue;
    }
    try {
      // Bound threads are usually not the session's current one, so persist the controller-owned key through the session gateway.
      await session.thread.setSettingOn({ threadId: binding.threadId, key: 'currentModelId', value: input.modelId });
      applied.push(binding.threadId);
    } catch (error) {
      console.warn('[factory] applying the default model failed for thread', binding.threadId, error);
      skipped.push({ threadId: binding.threadId, reason: 'apply-failed' });
    }
  }
  return { applied, skipped };
}
