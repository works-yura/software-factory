import { selfReviewWorkBoard } from '@factory/pipelines';

import { boardDefinitionOf } from './stored-board.ts';
import type { StoredBoardInput } from './base.ts';

/**
 * The Work seed the runner migration fills from: Work as it was while it had its self-review phase.
 * Only projects stored before then hold the old defaults it replaces, and their rows still have
 * that phase, so they get its runner rather than today's seed, which has no such phase.
 */
export function workSeedWithSelfReview(): StoredBoardInput {
  return boardDefinitionOf(selfReviewWorkBoard);
}
