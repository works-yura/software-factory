import { REPRODUCTION_TEST_SHA_KEY } from '@factory/core';
import type { BoardTransitionPolicy } from '@factory/core';

import { workTransitionPolicy } from '../work/transition-policy.ts';

/** Where a triage agent may send a card it classified as something other than a bug. */
const NOT_A_BUG_TARGETS: ReadonlySet<string> = new Set(['canceled', 'intake']);

/**
 * Bug reuses Work's policy — structured triage classification, the plan approval gate, the
 * change-request and self-review guards on Done — with three changes:
 *
 * - cards cannot change boards, so a triage agent that finds no bug closes the card with its
 *   reason (or parks it for a person) instead of carrying it on;
 * - the plan approval gate guards the reproduction test (`tests`), the phase an approved plan
 *   starts, exactly as Work's guards Building;
 * - an agent reaches Fix (`execute`) only from a recorded reproduction test, or back from Review.
 */
export const bugTransitionPolicy: BoardTransitionPolicy = context => {
  const { actor, requestedTriageType, fromStage, toStage, item } = context;
  if (
    actor.type === 'agent' &&
    actor.role === 'triage' &&
    requestedTriageType !== undefined &&
    requestedTriageType !== 'bug' &&
    !NOT_A_BUG_TARGETS.has(toStage)
  ) {
    return {
      type: 'reject',
      code: 'invalid_transition',
      reason:
        `Triaged as "${requestedTriageType}", not a bug. Cards cannot change boards: move this card to ` +
        '`canceled` with a rationale that names the board it belongs on, or to `intake` for a maintainer.',
    };
  }
  if (actor.type !== 'human' && toStage === 'execute' && fromStage !== 'review') {
    if (fromStage !== 'tests') {
      return {
        type: 'reject',
        code: 'invalid_transition',
        reason: 'A bug reaches Fix through its reproduction test: move the card to `tests` first.',
      };
    }
    if (typeof item.metadata?.[REPRODUCTION_TEST_SHA_KEY] !== 'string') {
      return {
        type: 'reject',
        code: 'invalid_transition',
        reason:
          'No reproduction test is recorded. Commit the failing test and record it with ' +
          'factory_record_reproduction_test, or move the card to `intake` when it does not reproduce.',
      };
    }
  }
  // Entering the reproduction test is where Work's Building gates apply on this board.
  return workTransitionPolicy(toStage === 'tests' ? { ...context, toStage: 'execute' } : context);
};
