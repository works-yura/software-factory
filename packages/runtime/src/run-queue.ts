import type { Card, FactoryDeferredDecisionRecord, WorkItemsStorage } from '@factory/store';
import { isRunBearingDecision } from './dispatcher.ts';
import { currentStage } from './transition-service.ts';

const LISTED_WAITING_RUNS = 50;

/** One run-bearing decision on the run queue; `GET …/run-queue` (`runQueueResponseSchema` in `@factory/contracts`). */
export interface RunQueueEntry {
  decisionId: string;
  /** `waiting`: no slot yet. `claimed`: a server holds a slot for it, starting or running the run. */
  state: 'waiting' | 'claimed';
  type: 'invokeSkill' | 'sendMessage' | 'signalActivity';
  role: string | null;
  /** The skill an `invokeSkill` run starts; `null` for a prompt run and for messages and activity. */
  skillName: string | null;
  /** When it became claimable for `waiting`, when it was claimed for `claimed`. */
  queuedSince: string;
  workItem: { id: string; key: string | null; title: string; board: string | null; phase: string | null } | null;
}

export interface RunQueue {
  /** This server process's run slots; `null` when it runs no dispatcher. Other servers keep their own. */
  slots: { scope: 'server'; inUse: number; cap: number } | null;
  /** The project's runs holding a slot on any server. */
  running: number;
  claimed: RunQueueEntry[];
  /** Every waiting run, though `queued` lists at most the oldest 50. */
  queuedCount: number;
  queued: Array<RunQueueEntry & { position: number }>;
}

/** A lease past its expiry belongs to a server that stopped renewing it: the next claim takes it back. */
function holdsSlot(decision: FactoryDeferredDecisionRecord, now: Date): boolean {
  return decision.status === 'leased' && (decision.leaseExpiresAt?.getTime() ?? 0) > now.getTime();
}

function waitsForSlot(decision: FactoryDeferredDecisionRecord, now: Date): boolean {
  if (decision.status === 'leased') return !holdsSlot(decision, now);
  // A postponed move or a retry backing off is not waiting on a slot yet.
  return decision.availableAt.getTime() <= now.getTime();
}

function entry(
  decision: FactoryDeferredDecisionRecord,
  state: RunQueueEntry['state'],
  cards: ReadonlyMap<string, Card>,
): RunQueueEntry {
  const payload = decision.decision;
  const card = decision.workItemId ? cards.get(decision.workItemId) : undefined;
  const since =
    state === 'claimed'
      ? decision.updatedAt
      : new Date(Math.max(decision.createdAt.getTime(), decision.availableAt.getTime()));
  return {
    decisionId: decision.id,
    state,
    type: payload.type as RunQueueEntry['type'],
    role: typeof payload.role === 'string' ? payload.role : null,
    skillName: payload.type === 'invokeSkill' && typeof payload.skillName === 'string' ? payload.skillName : null,
    queuedSince: since.toISOString(),
    workItem: card
      ? {
          id: card.id,
          key: card.workItem.key,
          title: card.title,
          board: card.board,
          phase: currentStage(card.stages) ?? null,
        }
      : null,
  };
}

/**
 * The project's run-bearing decisions in the order the dispatcher claims them (oldest first),
 * split into those waiting for a slot and those a server already holds one for.
 */
export async function readRunQueue(input: {
  workItems: WorkItemsStorage;
  orgId: string;
  factoryProjectId: string;
  slots: { inUse: number; cap: number } | undefined;
  now: Date;
}): Promise<RunQueue> {
  const { workItems, orgId, factoryProjectId, now } = input;
  const open = (
    await workItems.listDeferredDecisions(orgId, factoryProjectId, { statuses: ['pending', 'retry', 'leased'] })
  ).filter(decision => isRunBearingDecision(decision.decision));
  const claimed = open.filter(decision => holdsSlot(decision, now));
  const waiting = open.filter(decision => waitsForSlot(decision, now));
  const listed = waiting.slice(0, LISTED_WAITING_RUNS);
  const ids = [...claimed, ...listed].flatMap(decision => (decision.workItemId ? [decision.workItemId] : []));
  const cards = new Map((await workItems.listByIds({ orgId, factoryProjectId, ids })).map(card => [card.id, card]));
  return {
    slots: input.slots ? { scope: 'server', ...input.slots } : null,
    running: claimed.length,
    claimed: claimed.map(decision => entry(decision, 'claimed', cards)),
    queuedCount: waiting.length,
    queued: listed.map((decision, index) => ({ ...entry(decision, 'waiting', cards), position: index + 1 })),
  };
}
