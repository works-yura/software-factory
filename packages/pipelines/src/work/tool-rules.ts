import type { FactoryToolResultRuleContext } from '@factory/core';

import { changeRequestNoun, metadataString, untrustedSourceReference } from './references.ts';

function resultContent(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const content = (value as { content?: unknown }).content;
  return typeof content === 'string' ? content : undefined;
}

/**
 * A `submit_plan` rule that moves an approved Planning card to `stage` on the card's own board.
 * Interactive-session path only: the plan skills never call submit_plan — they request the move
 * with factory_transition_work_item directly.
 */
export function advanceApprovedPlanTo(stage: string) {
  return (context: FactoryToolResultRuleContext) => {
    if (
      context.result.status !== 'success' ||
      context.item.stages.length !== 1 ||
      context.item.stages[0] !== 'planning' ||
      context.actor.type !== 'agent' ||
      context.actor.role !== 'plan' ||
      !resultContent(context.result.value)?.startsWith('Plan approved.')
    ) {
      return;
    }
    return {
      type: 'transition',
      idempotencyKey: `${context.ingress.id}:approved-plan`,
      board: context.board,
      stage,
    } as const;
  };
}

/** Work: an approved plan goes straight to Building. */
export const advanceApprovedPlan = advanceApprovedPlanTo('execute');

/**
 * Self-review approves in place: the card stays in Review and the builder, woken
 * there, opens the change request from the approved head.
 */
export function openApprovedChangeRequest(context: FactoryToolResultRuleContext) {
  if (
    context.result.status !== 'success' ||
    context.actor.type !== 'agent' ||
    context.actor.role !== 'review' ||
    context.item.stages.length !== 1 ||
    context.item.stages[0] !== 'review' ||
    context.item.metadata?.selfReviewVerdict !== 'approve' ||
    typeof context.item.metadata?.openPullRequestNumber === 'number'
  ) {
    return;
  }
  const changeRequest = changeRequestNoun(context.item);
  const head = metadataString(context.item, 'selfReviewedHeadSha');
  const summary = metadataString(context.item, 'selfReviewFindings');
  return {
    type: 'invokeSkill',
    idempotencyKey: `${context.ingress.id}:open-change-request`,
    role: 'work',
    prompt:
      `Self-review approved this work${head ? ` at branch head ${head}` : ''}. Open the ${changeRequest} now from that ` +
      `exact head; do not push new commits first (a new head needs another self-review). In the ${changeRequest} ` +
      "body, include a short self-review summary and the self-review's test report." +
      (summary ? `\n\nSelf-review report:\n${summary}` : '') +
      `\n\n${untrustedSourceReference(context.item)}`,
  } as const;
}
