import type { BoardTransitionPolicy } from '@factory/core';

// Done means the PR merged. A review agent records its verdict and leaves the
// card in Reviewing, so a blocking finding never reads as finished work.
export const reviewTransitionPolicy: BoardTransitionPolicy = ({ actor, toStage }) => {
  if (toStage !== 'done' || actor.type !== 'agent') return undefined;
  return {
    type: 'reject',
    code: 'invalid_transition',
    reason:
      'Done is reserved for merged pull requests. Record the verdict with factory_record_review_verdict; the card stays in Reviewing.',
  };
};
