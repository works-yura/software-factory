import { compileBoardDefinition } from '@factory/core';
import type { BoardPhaseDefinition, BoardTransitionPolicy, BoardTransitionPolicyResult } from '@factory/core';

import { productChildWorkItemIds, productDocumentGateFailure } from './documents.ts';
import type { ProductDocumentType } from './documents.ts';

export type ProductBoardPhase =
  | 'intake'
  | 'enrich'
  | 'brief'
  | 'client-review'
  | 'spec'
  | 'spec-review'
  | 'phases'
  | 'phases-review'
  | 'done'
  | 'canceled';

/**
 * Phases the Product board had before it gained Research, and what each became. Stored boards,
 * cards and intake routes that still name an old phase are moved onto the new one once, at startup.
 */
export const PRODUCT_LEGACY_PHASE_RENAMES: Readonly<Record<string, ProductBoardPhase>> = {
  breakdown: 'phases',
  'breakdown-review': 'phases-review',
};

/**
 * The session context every Product phase runs in. All working phases share one session per
 * card, so the conversation that shaped the brief carries into the spec and the phases, alongside
 * the documents committed to the repository.
 */
export const PRODUCT_CONTEXT = 'product';

type GateCard = { readonly metadata: Record<string, unknown> | null };

/** The document a phase must have passed its check for before the card leaves it for `next`. */
const DOCUMENT_GATES: Readonly<Partial<Record<ProductBoardPhase, { type: ProductDocumentType; next: ProductBoardPhase }>>> =
  {
    brief: { type: 'brief', next: 'client-review' },
    'spec-review': { type: 'spec', next: 'phases' },
    phases: { type: 'tasks', next: 'phases-review' },
  };

function reject(reason: string): BoardTransitionPolicyResult {
  return { type: 'reject', code: 'invalid_transition', reason };
}

/**
 * The moves Product holds back, for every mover: a document must have passed its last check,
 * recorded on the card, before the card goes on from the phase that writes it, and Done needs the
 * Development cards the phases were filed as. Phases start their work from their runners alone, so
 * these gates are the board's transition policy.
 */
export function productGateRejection(item: GateCard, fromStage: string, toStage: string): string | undefined {
  const gate = DOCUMENT_GATES[fromStage as ProductBoardPhase];
  if (gate && toStage === gate.next) return productDocumentGateFailure(item.metadata, gate.type) ?? undefined;
  if (fromStage === 'phases-review' && toStage === 'done' && productChildWorkItemIds(item.metadata).length === 0) {
    return 'This card has filed no Development cards yet. Run Phases to file them (factory_create_work_item), then move it to Done.';
  }
  return undefined;
}

const productGates: BoardTransitionPolicy = ({ item, fromStage, toStage }) => {
  const reason = productGateRejection(item, fromStage, toStage);
  return reason ? reject(reason) : undefined;
};

const resting = (description: string) => ({ kind: 'resting' as const, description });

/**
 * Product: what to build, decided before any code. No code is ever written on this board. A
 * request gathers the engineer's context (Research), becomes a brief the client approves (goal,
 * use cases, scope, user-level acceptance, phases, estimate, technology at the client's level),
 * then one technical spec for the team (architecture and flows in Mermaid, contracts, data, what
 * changes in every component, test plan), then phases filed as cards on Development (Work). Each
 * working phase is a conversation with a person, so none starts on its own. A project keeps all
 * its documentation in one folder (a docs repository, or one folder in a monorepo), laid out as
 * `<docs>/changes/<change>/{research,requirements,design,tasks}.md`; each Factory says where in
 * the phase instructions, or the agent finds it and confirms.
 *
 * Sending the brief (requirements.md) for approval needs its document check to have passed, and
 * so do leaving Spec review for Phases (design.md) and handing the phases (tasks.md) over for
 * review; Done needs the Development cards the phases were filed as.
 */
export const productBoard = compileBoardDefinition<
  'product',
  Record<ProductBoardPhase, BoardPhaseDefinition<ProductBoardPhase>>
>({
  id: 'product',
  name: 'Product',
  initialPhase: 'intake',
  // Product compiles itself, so it may keep a policy for the document gates phases can't say.
  transitionPolicy: productGates,
  phases: {
    intake: {
      name: 'Intake',
      kind: 'resting',
      // Brief or Spec straight from Intake when the research or the brief already exists.
      nextPhases: ['enrich', 'brief', 'spec', 'canceled'],
    },
    enrich: {
      name: 'Research',
      description:
        'Interview the engineer before anything is written: how the system works, pitfalls, constraints, how they would do it.',
      kind: 'working',
      runner: { context: PRODUCT_CONTEXT, skill: 'product-enrich' },
      nextPhases: ['brief', 'spec', 'canceled'],
    },
    brief: {
      name: 'Brief',
      description:
        'Shape the request with a person into the client-facing brief: goal, use cases, scope, acceptance, phases and estimate.',
      kind: 'working',
      runner: { context: PRODUCT_CONTEXT, skill: 'product-brief' },
      nextPhases: ['client-review', 'canceled'],
    },
    'client-review': {
      name: 'Approval',
      ...resting(
        'The brief waits for approval (the client, or whoever signs it off). Back to Brief for revisions, on to Spec once agreed.',
      ),
      nextPhases: ['brief', 'spec', 'canceled'],
    },
    spec: {
      name: 'Spec',
      description:
        'Write the technical spec for the team: how the feature fits the system, its diagrams, contracts, data, component changes and test plan. No code.',
      kind: 'working',
      runner: { context: PRODUCT_CONTEXT, skill: 'product-spec' },
      nextPhases: ['spec-review', 'canceled'],
    },
    'spec-review': {
      name: 'Spec review',
      ...resting('The team reads the spec. Back to Spec for changes, on to Phases once its check passed.'),
      nextPhases: ['spec', 'phases', 'canceled'],
    },
    phases: {
      name: 'Phases',
      description:
        'Split the spec into independently verifiable phases and file each as a Development card per repository. No code.',
      kind: 'working',
      runner: { context: PRODUCT_CONTEXT, skill: 'product-phases' },
      nextPhases: ['phases-review', 'canceled'],
    },
    'phases-review': {
      name: 'Phases review',
      ...resting('A person checks the filed cards. Back to Phases to fix them, Done once right.'),
      nextPhases: ['phases', 'done', 'canceled'],
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
