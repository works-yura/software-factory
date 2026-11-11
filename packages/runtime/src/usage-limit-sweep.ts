import type { ProjectBoardSource } from '@factory/core';
import type { FactoryDeferredDecisionRecord, WorkItemsStorage } from '@factory/store';

import { decisionRetryable, overtakenDecisionIds } from './decision-applicability.ts';
import { USAGE_LIMIT_MAX_WAIT_MS, usageLimitOf } from './usage-limit.ts';

/** How long an account sits out when nobody said when its limit resets (the account pool's cooldown). */
const UNKNOWN_RESET_COOLDOWN_MS = 60 * 60_000;
const SWEEP_LIMIT = 200;

export interface UsageLimitSweepResult {
  /** Decisions put back in the queue. */
  requeued: FactoryDeferredDecisionRecord[];
  /** The earliest reset still ahead, when a candidate waits for one. */
  nextAt?: Date;
}

type SweepStorage = Pick<
  WorkItemsStorage,
  'listUsageLimitFailureCandidates' | 'retryDeferredDecision' | 'listByIds' | 'listDecisionsForEvaluations'
>;

/**
 * When the limit a failed decision's run hit resets: the time its error names (the account
 * pool's "comes back at …"), or a cooldown after it failed. `undefined` for any other failure.
 */
function usageLimitResetOf(record: FactoryDeferredDecisionRecord): Date | undefined {
  if (!record.lastError) return undefined;
  const limit = usageLimitOf(record.lastError, record.updatedAt);
  if (!limit) return undefined;
  return limit.resetsAt ?? new Date(record.updatedAt.getTime() + UNKNOWN_RESET_COOLDOWN_MS);
}

/**
 * Requeues decisions that failed for good because every model account was out of usage —
 * failures from before runs waited for the reset on their own, which burned their attempts in
 * seconds — once that limit has reset. Each is requeued once (it counts as a usage wait), only
 * while it is still a retryable failure and its card has not moved on from the phase it was
 * decided for, as a person's retry would be. A decision that waited out the limit and then gave up
 * (`run_usage_limited`) is left for a person.
 */
export async function requeueUsageLimitedDecisions({
  storage,
  boards,
  now,
}: {
  storage: SweepStorage;
  boards: ProjectBoardSource;
  now: Date;
}): Promise<UsageLimitSweepResult> {
  const candidates = await storage.listUsageLimitFailureCandidates({
    since: new Date(now.getTime() - USAGE_LIMIT_MAX_WAIT_MS),
    limit: SWEEP_LIMIT,
  });
  let nextAt: Date | undefined;
  const due = new Map<string, FactoryDeferredDecisionRecord[]>();
  for (const record of candidates) {
    if (record.usageWaits > 0 || !decisionRetryable(record, false)) continue;
    const resetAt = usageLimitResetOf(record);
    if (!resetAt) continue;
    if (resetAt.getTime() > now.getTime()) {
      if (!nextAt || resetAt.getTime() < nextAt.getTime()) nextAt = resetAt;
      continue;
    }
    const scope = `${record.orgId}\0${record.factoryProjectId}`;
    due.set(scope, [...(due.get(scope) ?? []), record]);
  }
  const requeued: FactoryDeferredDecisionRecord[] = [];
  for (const records of due.values()) {
    const scope = { orgId: records[0]!.orgId, factoryProjectId: records[0]!.factoryProjectId };
    const overtaken = await overtakenDecisionIds(storage, await boards.load(scope), scope, records);
    for (const record of records) {
      if (overtaken.has(record.id)) continue;
      const retried = await storage.retryDeferredDecision(scope.orgId, scope.factoryProjectId, record.id, now, {
        usageWait: true,
      });
      if (retried) requeued.push(retried);
    }
  }
  return { requeued, ...(nextAt ? { nextAt } : {}) };
}
