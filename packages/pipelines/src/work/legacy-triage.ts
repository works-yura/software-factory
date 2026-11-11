import { compileBoardDefinition } from '@factory/core';
import type { BoardPhaseDefinition } from '@factory/core';

import { workBoard } from './board.ts';

/** Work's Triage phase as projects stored it before new projects' Work dropped it (upstream #29901). Frozen. */
export const LEGACY_TRIAGE_PHASE: BoardPhaseDefinition<string> = {
  name: 'Triage',
  kind: 'working',
  runner: { skill: 'factory-triage', context: 'triage' },
  // A confirmed bug goes to Planning; any other open issue waits in Intake for a person.
  nextPhases: ['intake', 'planning', 'done', 'canceled'],
};

/** The moves into Triage each phase had, at the place they had them. */
const MOVES_INTO_TRIAGE: Readonly<Record<string, { after: string | null }>> = {
  intake: { after: null },
  planning: { after: 'execute' },
};

function withTriage(nextPhases: readonly string[], after: string | null): string[] {
  const index = after === null ? 0 : nextPhases.indexOf(after) + 1;
  return [...nextPhases.slice(0, index), 'triage', ...nextPhases.slice(index)];
}

/**
 * Work as Factory stored it before new projects' Work dropped Triage: today's Work plus its
 * Triage phase and the moves into it. A project that existed before then is given this one when
 * Factory stores its Work, so an upgrade never changes the phases its cards can sit in; reset
 * gives it back too. Only a project Factory created with today's Work resets to `workBoard`.
 * Compiled with `workBoard` as its code board, as a stored Work row is.
 */
export const triageWorkBoard = compileBoardDefinition(
  {
  id: workBoard.id,
  name: workBoard.name,
  initialPhase: workBoard.initialPhase,
  ...(workBoard.transitionPolicy ? { transitionPolicy: workBoard.transitionPolicy } : {}),
  sourceClosed: workBoard.sourceClosed,
  triageClassification: workBoard.triageClassification,
  phases: Object.fromEntries(
    Object.entries(workBoard.phases).flatMap(([key, phase]): [string, BoardPhaseDefinition<string>][] => {
      const definition = phase as unknown as BoardPhaseDefinition<string>;
      const into = MOVES_INTO_TRIAGE[key];
      const withMove = into
        ? { ...definition, nextPhases: withTriage(definition.nextPhases ?? [], into.after) }
        : definition;
      return key === 'intake' ? [[key, withMove], ['triage', LEGACY_TRIAGE_PHASE]] : [[key, withMove]];
    }),
  ),
  },
  workBoard,
);
