import { defineBoard } from '@factory/core';

import { reviewPullRequest } from './phase-rules.ts';
import { reviewTransitionPolicy } from './transition-policy.ts';

export const reviewBoard = defineBoard({
  id: 'review',
  title: 'Review',
  initialPhase: 'intake',
  transitionPolicy: reviewTransitionPolicy,
  phases: {
    intake: {
      title: 'Intake',
      kind: 'resting',
      outcomes: {
        reviewRequested: 'review',
        merged: 'done',
        closed: 'canceled',
      },
    },
    review: {
      title: 'Reviewing',
      kind: 'working',
      role: 'review',
      outcomes: {
        parked: 'intake',
        merged: 'done',
        closed: 'canceled',
      },
      onEnter: { pullRequest: reviewPullRequest, gitlabPullRequest: reviewPullRequest },
    },
    done: {
      title: 'Done',
      kind: 'terminal',
      outcomes: { updated: 'review' },
    },
    canceled: {
      title: 'Canceled',
      kind: 'terminal',
      outcomes: { reviewRequested: 'review' },
    },
  },
});

export type ReviewBoardPhase = keyof typeof reviewBoard.phases;

export function isReviewBoardPhase(value: string): value is ReviewBoardPhase {
  return Object.hasOwn(reviewBoard.phases, value);
}
