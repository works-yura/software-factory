import type { Card } from '@factory/store';

/** Where a card stands on its board, as the stop after a context reads it. */
export type CardPlace = { kind: 'terminal' } | { kind: 'phase'; context: string | undefined };

export interface ContextSandboxStopsOptions {
  workItems: { get(input: { orgId: string; id: string }): Promise<Card | null> };
  /** The context the card's current phase runs in, or that it finished. */
  placeOf(card: Card): Promise<CardPlace>;
  /** Whether a run is going on in the session in this process (an agent, or a person chatting). */
  isRunning(sessionId: string): boolean;
  /** Stops a session's sandbox; its row, branch and files stay. */
  stopSession(input: { orgId: string; sessionId: string }): Promise<void>;
  /** How often a stop waiting for a run checks it again. */
  pollMs?: number;
  /** How long a stop waits for runs to end before giving up (the next run stops nothing). */
  maxWaitMs?: number;
  warn?: (message: string, details: Record<string, unknown>) => void;
}

const DEFAULT_POLL_MS = 2_000;
const DEFAULT_MAX_WAIT_MS = 60 * 60_000;

/**
 * Stops a card's sandbox once the card no longer runs in any context
 * (port of upstream #29981, adapted to one sandbox folder per card).
 *
 * Upstream gives every context its own VM and stops it as soon as the card
 * leaves that context. In v4 every session of a card works in the card's one
 * folder, so leaving Triage for Planning stops nothing: the next context
 * keeps using the folder. Only a move into a phase that runs no context (a
 * resting phase that waits on a person) leaves the folder idle; then every
 * session of the card stops its sandbox, keeping files and branch, and the
 * card's next run starts them again. Done and Canceled already release the
 * whole folder (`retireWorkItemSessions`).
 *
 * A run still going on in one of the card's sessions (the agent whose own tool
 * call made the move, or a person chatting) keeps the folder until it ends: the
 * stop waits for it outside the transition, because that run may be the very
 * tool call waiting on the move, and then checks the card has not come back
 * into a context. Never another session's processes while it runs.
 */
export function createContextSandboxStops(options: ContextSandboxStopsOptions) {
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const warn = options.warn ?? ((message, details) => console.warn(`[factory] ${message}`, details));

  const idle = async (orgId: string, workItemId: string): Promise<Card | undefined> => {
    const card = await options.workItems.get({ orgId, id: workItemId });
    if (!card) return undefined;
    const place = await options.placeOf(card);
    return place.kind === 'phase' && place.context === undefined ? card : undefined;
  };

  const sessionsOf = (card: Card) => [...new Set(Object.values(card.sessions).map(session => session.sessionId))];

  const stopWhenIdle = async (orgId: string, workItemId: string, sessionIds: string[]): Promise<void> => {
    const deadline = Date.now() + maxWaitMs;
    while (sessionIds.some(sessionId => options.isRunning(sessionId))) {
      if (Date.now() >= deadline) return;
      await new Promise(resolve => setTimeout(resolve, pollMs));
    }
    // The card may have come back into a context while its runs ended.
    const card = await idle(orgId, workItemId);
    if (!card) return;
    for (const sessionId of sessionsOf(card)) {
      // A run that started meanwhile keeps its sandbox; its own next move decides again.
      if (options.isRunning(sessionId)) continue;
      await options.stopSession({ orgId, sessionId }).catch((error: unknown) =>
        warn('Card sandbox stop failed', { orgId, workItemId, sessionId, error: String(error) }),
      );
    }
  };

  return async (args: {
    orgId: string;
    workItemId: string;
    revision: number;
    toContext: string | undefined;
  }): Promise<void> => {
    // The card's next context works in the same folder.
    if (args.toContext !== undefined) return;
    const card = await options.workItems.get({ orgId: args.orgId, id: args.workItemId });
    // A later move already decided for the card.
    if (!card || card.revision !== args.revision) return;
    const sessionIds = sessionsOf(card);
    if (sessionIds.length === 0) return;
    if (sessionIds.some(sessionId => options.isRunning(sessionId))) {
      void stopWhenIdle(args.orgId, args.workItemId, sessionIds).catch((error: unknown) =>
        warn('Card sandbox stop failed', { orgId: args.orgId, workItemId: args.workItemId, error: String(error) }),
      );
      return;
    }
    await stopWhenIdle(args.orgId, args.workItemId, sessionIds);
  };
}
