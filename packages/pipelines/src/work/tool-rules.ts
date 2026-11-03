import { hasOpenChangeRequest } from '@factory/core';
import type { FactoryToolResultRuleContext } from '@factory/core';

import { changeRequestNoun, metadataString, untrustedSourceReference } from './references.ts';

function resultContent(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const content = (value as { content?: unknown }).content;
  return typeof content === 'string' ? content : undefined;
}

// Interactive-session path only: factory-plan never calls submit_plan — it
// advances planning → execute via factory_transition_work_item directly.
export function advanceApprovedPlan(context: FactoryToolResultRuleContext) {
  if (
    context.result.status !== 'success' ||
    context.item.stages.length !== 1 ||
    context.item.stages[0] !== 'planning' ||
    context.actor.type !== 'agent' ||
    // Planning runs in the `work` session; `plan` is the role of cards planned before that.
    (context.actor.role !== 'work' && context.actor.role !== 'plan') ||
    !resultContent(context.result.value)?.startsWith('Plan approved.')
  ) {
    return;
  }
  return {
    type: 'transition',
    idempotencyKey: `${context.ingress.id}:approved-plan`,
    board: context.board,
    stage: 'execute',
  } as const;
}

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
    hasOpenChangeRequest(context.item.metadata)
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
