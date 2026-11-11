import { describe, expect, it } from 'vitest';

import { phaseRunDecision } from '@factory/core';
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
      url: source === 'manual' ? null : 'https://app.clickup.com/t/abc',
      stages: ['intake'],
      triageType: null,
      metadata: { description: 'Steps: open the app' },
      workItem: providerWorkItemForTests({ provider: 'clickup', key: 'abc', metadata: { identifier: 'abc' } }),
    },
    source: 'manual',
    stage: 'triage',
    fromStage: 'intake',
  } as unknown as FactoryStageRuleContext;
}

// The task text reaches the agent through the factory-work-item signal; the kickoff only names the card.
describe('Work triage entry for cards without a provider issue', () => {
  it('starts the triage skill for a ClickUp card, naming it by its link', () => {
    const decision = phaseRunDecision(workBoard, 'triage', entering('clickup-task'));
    expect(decision).toMatchObject({ type: 'invokeSkill', role: 'triage', skillName: 'factory-triage' });
    expect(decision?.arguments).toBe('Work item (https://app.clickup.com/t/abc)');
  });

  it('starts the triage skill for a card a person made by hand', () => {
    const decision = phaseRunDecision(workBoard, 'triage', entering('manual'));
    expect(decision).toMatchObject({ type: 'invokeSkill', role: 'triage', skillName: 'factory-triage' });
  });
});
