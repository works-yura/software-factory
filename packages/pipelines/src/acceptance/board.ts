import { compileBoardDefinition } from '@factory/core';
import type { BoardPhaseDefinition } from '@factory/core';

import { verifyAcceptanceCriteria } from './phase-rules.ts';
import { acceptanceTransitionPolicy } from './transition-policy.ts';

type AcceptancePhase = 'queued' | 'verifying' | 'decision' | 'accepted';

/** A separate, manual record of product acceptance after PR review. */
export const acceptanceBoard = compileBoardDefinition<'acceptance', Record<AcceptancePhase, BoardPhaseDefinition<AcceptancePhase>>>({
  id: 'acceptance',
  name: 'Acceptance',
  initialPhase: 'queued',
  transitionPolicy: acceptanceTransitionPolicy,
  phases: {
    queued: {
      name: 'Awaiting evidence',
      kind: 'resting',
      outcomes: { verify: 'verifying' },
    },
    verifying: {
      name: 'Verifying criteria',
      kind: 'working',
      runner: { context: 'validator' },
      outcomes: { submit: 'decision', retry: 'queued' },
      onEnter: { manual: verifyAcceptanceCriteria },
    },
    decision: {
      name: 'Product decision',
      kind: 'resting',
      outcomes: { accept: 'accepted', reject: 'queued' },
    },
    accepted: { name: 'Accepted', kind: 'terminal' },
  },
});
