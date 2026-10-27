import type { BoardTransitionPolicy } from '@factory/core';

// Only a person accepts the product result; the validator only gathers evidence.
export const acceptanceTransitionPolicy: BoardTransitionPolicy = context => {
  if (context.toStage !== 'accepted' || context.isHumanTransition) return undefined;
  return {
    type: 'reject',
    code: 'approval_required',
    reason: 'A person must accept the product result after reviewing evidence.',
  };
};
