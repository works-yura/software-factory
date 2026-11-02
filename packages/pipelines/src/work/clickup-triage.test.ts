import { describe, expect, it } from 'vitest';

import type { FactoryStageRuleContext } from '@factory/core';

import { workBoard } from './board.ts';

function entering(source: string): FactoryStageRuleContext {
  return {
    ingress: { type: 'system', id: 'ingress-1' },
    item: {
      id: 'item-1',
      source,
      sourceKey: 'abc',
      title: 'Crash on login',
      url: 'https://app.clickup.com/t/abc',
      stages: ['triage'],
      triageType: null,
      metadata: { identifier: 'abc', description: 'Steps: open the app' },
    },
    source: 'manual',
    stage: 'triage',
  } as unknown as FactoryStageRuleContext;
}

describe('Work triage entry for imported tasks', () => {
  const handler = workBoard.phases.triage.onEnter?.manual;

  it('starts the triage skill for a ClickUp card, with the task text as untrusted data', async () => {
    const decision = await handler?.(entering('clickup-task'));
    expect(decision).toMatchObject({ type: 'invokeSkill', role: 'triage', skillName: 'factory-triage' });
    expect((decision as { arguments: string }).arguments).toContain('Steps: open the app');
  });

  it('leaves a card a person made by hand alone', async () => {
    expect(await handler?.(entering('manual'))).toBeUndefined();
  });
});
