import { compileBoardDefinition } from '@factory/core';
import type { BoardPhaseDefinition } from '@factory/core';

export type ProductBoardPhase =
  | 'intake'
  | 'brief'
  | 'client-review'
  | 'spec'
  | 'spec-review'
  | 'breakdown'
  | 'breakdown-review'
  | 'done'
  | 'canceled';

/**
 * The session context every Product phase runs in. Brief, spec and breakdown share one session
 * per card, so the agent keeps the conversation that shaped the brief when it writes the spec.
 */
export const PRODUCT_CONTEXT = 'product';

/**
 * Product: what to build, decided before any code. A request becomes a brief the client agrees
 * to, then a spec the team agrees to, then cards on Work. Each working phase is a conversation
 * with a person, so none starts on its own: a person starts the run, and moves the card on when
 * they accept the document. Where a project keeps its documents is told to the agent through
 * each phase's instructions, which each Factory sets.
 */
export const productBoard = compileBoardDefinition<
  'product',
  Record<ProductBoardPhase, BoardPhaseDefinition<ProductBoardPhase>>
>({
  id: 'product',
  name: 'Product',
  initialPhase: 'intake',
  phases: {
    intake: {
      name: 'Intake',
      kind: 'resting',
      // Spec straight from Intake when the brief already exists.
      nextPhases: ['brief', 'spec', 'canceled'],
    },
    brief: {
      name: 'Brief',
      description: 'Shape the request with a person into a brief: goal, scope, phases and estimate.',
      kind: 'working',
      runner: { context: PRODUCT_CONTEXT, skill: 'product-brief' },
      nextPhases: ['client-review', 'canceled'],
    },
    'client-review': {
      name: 'With the client',
      description: 'The client reads the brief. Back to Brief for revisions, on to Spec once agreed.',
      kind: 'resting',
      nextPhases: ['brief', 'spec', 'canceled'],
    },
    spec: {
      name: 'Spec',
      description: 'Turn the agreed brief into a specification per component, with a person.',
      kind: 'working',
      runner: { context: PRODUCT_CONTEXT, skill: 'product-spec' },
      nextPhases: ['spec-review', 'canceled'],
    },
    'spec-review': {
      name: 'Spec review',
      description: 'The team reads the spec. Back to Spec for changes, on to Breakdown once agreed.',
      kind: 'resting',
      nextPhases: ['spec', 'breakdown', 'canceled'],
    },
    breakdown: {
      name: 'Breakdown',
      description: 'Cut the agreed spec into work items for each repository.',
      kind: 'working',
      runner: { context: PRODUCT_CONTEXT, skill: 'product-breakdown' },
      nextPhases: ['breakdown-review', 'canceled'],
    },
    'breakdown-review': {
      name: 'Breakdown review',
      description: 'A person checks the work items filed on Work. Back to Breakdown to fix them, Done once right.',
      kind: 'resting',
      nextPhases: ['breakdown', 'done', 'canceled'],
    },
    done: {
      name: 'Done',
      kind: 'terminal',
    },
    canceled: {
      name: 'Canceled',
      kind: 'terminal',
      nextPhases: ['intake'],
    },
  },
});

export function isProductBoardPhase(value: string): value is ProductBoardPhase {
  return Object.hasOwn(productBoard.phases, value);
}
