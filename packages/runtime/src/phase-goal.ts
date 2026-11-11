import type { AgentGoalObjective, AgentGoals } from '@factory/harness';
import type { WorkItemsStorage } from '@factory/store';

/** Card metadata naming the goal Factory set for a phase, so leaving the phase ends it. */
export const PHASE_GOAL_METADATA_KEY = 'phaseGoal';

export interface PhaseGoalRecord {
  phaseKey: string;
  goalId: string;
  threadId: string;
  sessionId: string;
}

/** The session's goal facet, as the harness exposes it. */
export type GoalAgent = AgentGoals;

export function phaseGoalOf(metadata: Record<string, unknown> | null | undefined): PhaseGoalRecord | undefined {
  const value = metadata?.[PHASE_GOAL_METADATA_KEY];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const { phaseKey, goalId, threadId, sessionId } = value as Record<string, unknown>;
  if (
    typeof phaseKey !== 'string' ||
    typeof goalId !== 'string' ||
    typeof threadId !== 'string' ||
    typeof sessionId !== 'string'
  ) {
    return undefined;
  }
  return { phaseKey, goalId, threadId, sessionId };
}

/**
 * Make `objective` the thread's goal under `goalId`. A thread holds one objective and setting it
 * again replaces it (cancelling a verdict in flight), so a goal already stored under this id is
 * kept as it is: a retried delivery of the same decision must not restart its goal.
 */
export async function startPhaseGoal(
  agent: GoalAgent,
  input: {
    threadId: string;
    resourceId?: string;
    goalId: string;
    objective: string;
    maxRuns?: number;
    judgeModelId?: string;
  },
) {
  const existing = await agent.getObjective({ threadId: input.threadId });
  if (existing?.id === input.goalId) return existing;
  return agent.setObjective(input.objective, {
    id: input.goalId,
    threadId: input.threadId,
    ...(input.resourceId ? { resourceId: input.resourceId } : {}),
    ...(input.maxRuns !== undefined ? { maxRuns: input.maxRuns } : {}),
    ...(input.judgeModelId ? { judgeModelId: input.judgeModelId } : {}),
  });
}

/** The objective store of the thread a goal lives on, for a session that is no longer open. */
export interface PhaseGoalStore {
  read(threadId: string): Promise<AgentGoalObjective | undefined>;
  write(threadId: string, record: AgentGoalObjective): Promise<void>;
}

/**
 * Ends the goal Factory set for a phase once the card is somewhere else. Only that goal: a goal a
 * person set on the thread since (different id) or one already finished is left alone. A session
 * that is not open is ended through its thread's stored objective, so reopening it later does not
 * resume a goal its card has left.
 */
export function createPhaseGoalEnder(options: {
  workItems: Pick<WorkItemsStorage, 'get'>;
  /** The agent of the session that holds the goal, when that session is open. */
  agentFor: (goal: PhaseGoalRecord) => Promise<GoalAgent | undefined>;
  /** The thread objective store, used when the session is not open. */
  store: () => Promise<PhaseGoalStore | undefined>;
}) {
  return async (args: { orgId: string; workItemId: string; toStage: string }): Promise<void> => {
    const item = await options.workItems.get({ orgId: args.orgId, id: args.workItemId });
    const goal = phaseGoalOf(item?.metadata);
    if (!goal || goal.phaseKey === args.toStage) return;
    await endPhaseGoal(goal, options);
  };
}

/** Marks `goal` done on its thread if it is still the thread's unfinished objective. */
export async function endPhaseGoal(
  goal: Pick<PhaseGoalRecord, 'goalId' | 'threadId' | 'sessionId' | 'phaseKey'>,
  options: {
    agentFor: (goal: PhaseGoalRecord) => Promise<GoalAgent | undefined>;
    store: () => Promise<PhaseGoalStore | undefined>;
  },
): Promise<void> {
  const agent = await options.agentFor(goal);
  if (agent) {
    const record = await agent.getObjective({ threadId: goal.threadId });
    if (record?.id !== goal.goalId || record.status === 'done') return;
    await agent.updateObjectiveOptions({ threadId: goal.threadId, status: 'done' });
    return;
  }
  const store = await options.store();
  const record = await store?.read(goal.threadId);
  if (!store || record?.id !== goal.goalId || record.status === 'done') return;
  await store.write(goal.threadId, { ...record, status: 'done' });
}
