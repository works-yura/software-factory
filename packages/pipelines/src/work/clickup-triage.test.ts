import { describe, expect, it } from 'vitest';

import type { FactoryStageRuleContext } from '@factory/core';

import { providerWorkItemForTests } from '../testing.ts';
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
      metadata: { description: 'Steps: open the app' },
      workItem: providerWorkItemForTests({ provider: 'clickup', key: 'abc', metadata: { identifier: 'abc' } }),
    },
    source: 'manual',
    stage: 'triage',
  } as unknown as FactoryStageRuleContext;
}

describe('Work triage entry for cards without a provider issue', () => {
  const handler = workBoard.phases.triage.onEnter?.manual;

  it('starts the triage skill for a ClickUp card, with the task text as untrusted data', async () => {
    const decision = await handler?.(entering('clickup-task'));
    expect(decision).toMatchObject({ type: 'invokeSkill', role: 'triage', skillName: 'factory-triage' });
    expect((decision as { arguments: string }).arguments).toContain('Steps: open the app');
  });

  it('starts the triage skill for a card a person made by hand', async () => {
    const decision = await handler?.(entering('manual'));
    expect(decision).toMatchObject({ type: 'invokeSkill', role: 'triage', skillName: 'factory-triage' });
  });
});
