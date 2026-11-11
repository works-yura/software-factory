import type { PlanDecision } from '@factory/harness';
import type { ChatTranscriptSession } from '@factory/harness-claude-code-ui';
import { boardForWorkItem } from '@factory/core';
import type { FactoryTransitionService } from '@factory/runtime';
import type { SourceControlSessionLookup } from '@factory/session';
import type { WorkItemsStorage } from '@factory/store';

import { CLAUDE_THREAD_SETTINGS } from './start-coordinator.ts';

/**
 * A person approving a card's plan in a Claude Code chat: the card moves on, as
 * an approved plan of a Mastra session does (`advanceApprovedPlan`): to
 * Building. The session does not resume on its own; it holds the answer, and the next stage's start
 * runs it with the answer first. Anything else (a rejection, a session bound to
 * no card in Planning) is left to the session.
 *
 * Returns whether it took the answer over.
 */
export function createClaudePlanApproval(deps: {
  sessions: Pick<SourceControlSessionLookup, 'getBySessionId'>;
  workItems: Pick<WorkItemsStorage, 'get'>;
  transitionService: Pick<FactoryTransitionService, 'transition'>;
}) {
  return async (
    session: Pick<ChatTranscriptSession, 'id' | 'thread' | 'queuePlanAnswer'>,
    answer: { resumeData: PlanDecision; toolCallId: string; userId: string | undefined },
  ): Promise<boolean> => {
    if (answer.resumeData.action !== 'approved') return false;
    const workItemId = await session.thread.getSetting({ key: CLAUDE_THREAD_SETTINGS.workItemId });
    const row = await deps.sessions.getBySessionId(session.id);
    if (typeof workItemId !== 'string' || !row?.factoryProjectId) return false;
    const item = await deps.workItems.get({ orgId: row.orgId, id: workItemId });
    if (!item || boardForWorkItem(item) !== 'work' || item.stages.length !== 1 || item.stages[0] !== 'planning') {
      return false;
    }
    await session.queuePlanAnswer({ resumeData: answer.resumeData, toolCallId: answer.toolCallId });
    const userId = answer.userId ?? row.userId;
    const result = await deps.transitionService.transition({
      orgId: row.orgId,
      factoryProjectId: row.factoryProjectId,
      workItemId,
      board: 'work',
      stage: 'execute',
      expectedRevision: item.revision,
      actor: { type: 'human', id: userId },
      ingress: { type: 'human', identity: `human:${userId}:plan-approval:${answer.toolCallId}` },
      cause: 'plan_approved',
      planApproved: true,
    });
    if (result.status !== 'accepted') {
      throw new Error(`The plan was approved, but the card could not move on: ${result.reason}`);
    }
    return true;
  };
}
