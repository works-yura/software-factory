import { compileBoardDefinition } from '@factory/core';
import type { BoardPhaseDefinition } from '@factory/core';

import { OWN_CARD_HAND_OFF, workBoard } from './board.ts';

/** Building's goal while Work still had its self-review phase. Frozen: stored rows may hold it. */
export const SELF_REVIEW_BUILD_OBJECTIVE =
  'Build the plan approved in Planning for this work item. Done when every step of that plan is implemented on ' +
  "the work branch; the plan's verification gates (the tests, typecheck and lint it names, else the narrowest " +
  'relevant ones) were run on the final head and passed; the branch is pushed; and the card was moved on with ' +
  "factory_transition_work_item out of Building (to Review or PR review as the builder's hand-off says, or back to " +
  "Planning if the plan proved wrong); the builder's latest message names the move and the pushed head. " +
  OWN_CARD_HAND_OFF +
  ' Continue while any of that is missing. Waiting only when the agent asked a person a question it cannot ' +
  'answer from the repository.';

/** Building's `nextPhases` while Work still had its self-review phase. */
export const SELF_REVIEW_BUILD_NEXT_PHASES = ['review', 'pr-review', 'planning', 'done', 'canceled'];

/**
 * Work's `review` self-review phase as projects stored it before Work's seed dropped it. Their stored
 * rows keep it and keep running it; any other board may declare an equivalent phase.
 */
export const LEGACY_SELF_REVIEW_PHASE: BoardPhaseDefinition<string> = {
  name: 'Review',
  kind: 'working',
  runner: { skill: 'factory-self-review', context: 'review' },
  // A card re-entering Review with its change request already open waits for a person.
  autoStart: true,
  autoStartWhen: { operator: 'AND', conditions: [{ field: 'item.pullRequest', operator: 'not_exists' }] },
  tools: ['factory_record_review_verdict'],
  // Self-review sends the card back to Building, or parks it in Intake at its round limit.
  nextPhases: ['execute', 'intake', 'pr-review', 'done', 'canceled'],
};

/**
 * Work as projects stored it while Work still had its `review` self-review phase. Work's seed
 * dropped that phase, but a project's stored row keeps it (the runner migration fills from this
 * shape), and other boards may declare one.
 */
export const selfReviewWorkBoard = compileBoardDefinition({
  id: workBoard.id,
  name: workBoard.name,
  initialPhase: workBoard.initialPhase,
  ...(workBoard.transitionPolicy ? { transitionPolicy: workBoard.transitionPolicy } : {}),
  sourceClosed: workBoard.sourceClosed,
  triageClassification: workBoard.triageClassification,
  phases: Object.fromEntries(
    Object.entries(workBoard.phases).flatMap(([key, phase]): [string, BoardPhaseDefinition<string>][] => {
      const definition = phase as unknown as BoardPhaseDefinition<string>;
      if (key !== 'execute' || definition.kind !== 'working') return [[key, definition]];
      const goal = definition.runner?.goal && { ...definition.runner.goal, objective: SELF_REVIEW_BUILD_OBJECTIVE };
      return [
        [
          key,
          {
            ...definition,
            runner: { ...definition.runner, ...(goal ? { goal } : {}) },
            nextPhases: [...SELF_REVIEW_BUILD_NEXT_PHASES],
          },
        ],
        ['review', LEGACY_SELF_REVIEW_PHASE],
      ];
    }),
  ),
});
