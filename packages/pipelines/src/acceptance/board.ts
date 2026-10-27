import { defineBoard } from '@factory/core';
import type { BoardPhaseDefinition } from '@factory/core';

import { verifyAcceptanceCriteria } from './phase-rules.ts';
import { acceptanceTransitionPolicy } from './transition-policy.ts';

type AcceptancePhase = 'queued' | 'verifying' | 'decision' | 'accepted';

/** A separate, manual record of product acceptance after PR review. */
export const acceptanceBoard = defineBoard<'acceptance', Record<AcceptancePhase, BoardPhaseDefinition<AcceptancePhase>>>({
  id: 'acceptance',
  title: 'Acceptance',
  initialPhase: 'queued',
  transitionPolicy: acceptanceTransitionPolicy,
  phases: {
    queued: {
      title: 'Awaiting evidence',
      kind: 'resting',
      outcomes: { verify: 'verifying' },
    },
    verifying: {
      title: 'Verifying criteria',
      kind: 'working',
      role: 'validator',
      outcomes: { submit: 'decision', retry: 'queued' },
      onEnter: { manual: verifyAcceptanceCriteria },
    },
    decision: {
      title: 'Product decision',
      kind: 'resting',
      outcomes: { accept: 'accepted', reject: 'queued' },
    },
    accepted: { title: 'Accepted', kind: 'terminal' },
  },
});
