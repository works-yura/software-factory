import type { FactoryStageRuleContext } from '@factory/core';

export function verifyAcceptanceCriteria(context: FactoryStageRuleContext) {
  return {
    type: 'invokeSkill',
    idempotencyKey: `${context.ingress.id}:acceptance-verification`,
    role: 'validator',
    prompt:
      'Read the linked specification and pull request. Check every acceptance criterion against the runnable product or test evidence. Record pass, fail, or unverified with a direct link to evidence for each criterion. Do not modify code or accept the result. Summarize any blocked checks for the product owner.',
  } as const;
}
