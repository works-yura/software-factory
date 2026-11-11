import { triageWorkBoard } from '@factory/pipelines';

import { boardDefinitionOf } from './stored-board.ts';
import type { StoredBoardInput } from './base.ts';

/**
 * Work as Factory stored it before new projects' Work dropped Triage (upstream #29901). A project
 * Factory didn't create with today's Work is stored, and reset to, this one, so an upgrade never
 * changes the phases its cards can sit in.
 */
export function workSeedWithTriage(): StoredBoardInput {
  return boardDefinitionOf(triageWorkBoard);
}
