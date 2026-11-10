import { describe, expect, it } from 'vitest';

import type { FactoryStageRuleContext } from '@factory/core';
import { createDefaultBoardRegistry, defaultBoards } from '../defaults.ts';
import { PRODUCT_CONTEXT, productBoard } from './board.ts';

describe('Product board', () => {
  it('is installed by default next to Work', () => {
    expect(defaultBoards.map(board => board.id)).toEqual(['work', 'product']);
    expect(createDefaultBoardRegistry().get('product')).toBe(productBoard);
    expect(createDefaultBoardRegistry({ includeDefaultBoards: false }).get('product')).toBeUndefined();
  });

  it('runs brief, spec and breakdown in one product session, and rests between them', () => {
    const kinds = Object.fromEntries(Object.entries(productBoard.phases).map(([id, phase]) => [id, phase.kind]));
    expect(kinds).toEqual({
      intake: 'resting',
      brief: 'working',
      'client-review': 'resting',
      spec: 'working',
      'spec-review': 'resting',
      breakdown: 'working',
      'breakdown-review': 'resting',
      done: 'terminal',
      canceled: 'terminal',
    });
    for (const [phase, skill] of [
      ['brief', 'product-brief'],
      ['spec', 'product-spec'],
      ['breakdown', 'product-breakdown'],
    ] as const) {
      const definition = productBoard.phases[phase];
      if (definition.kind !== 'working') throw new Error(`${phase} should be working`);
      expect(definition.runner).toMatchObject({ context: PRODUCT_CONTEXT, skill });
      expect(productBoard.roleForPhase(phase)).toBe(PRODUCT_CONTEXT);
    }
  });

  it('never starts a phase on its own: a person starts each conversation', () => {
    for (const phase of Object.keys(productBoard.phases)) {
      expect(productBoard.startsAutomatically(phase)).toBe(false);
    }
  });

  it('lets a card skip the brief, loop through revisions, and only finish after the breakdown is checked', () => {
    const allowed = (from: string, to: string) => productBoard.allowsTransition(from as never, to as never);
    expect(allowed('intake', 'brief')).toBe(true);
    expect(allowed('intake', 'spec')).toBe(true);
    expect(allowed('intake', 'breakdown')).toBe(false);
    expect(allowed('brief', 'client-review')).toBe(true);
    expect(allowed('client-review', 'brief')).toBe(true);
    expect(allowed('client-review', 'spec')).toBe(true);
    expect(allowed('spec', 'spec-review')).toBe(true);
    expect(allowed('spec-review', 'spec')).toBe(true);
    expect(allowed('spec-review', 'breakdown')).toBe(true);
    expect(allowed('breakdown', 'breakdown-review')).toBe(true);
    expect(allowed('breakdown-review', 'breakdown')).toBe(true);
    expect(allowed('breakdown-review', 'done')).toBe(true);
    expect(allowed('brief', 'done')).toBe(false);
    expect(allowed('spec', 'done')).toBe(false);
    expect(allowed('breakdown', 'done')).toBe(false);
    expect(allowed('done', 'intake')).toBe(false);
    expect(allowed('canceled', 'intake')).toBe(true);
  });

  it("starts the phase's skill in the product session when a card enters a working phase", async () => {
    const context = {
      tenant: { orgId: 'org-1', projectId: 'project-1' },
      actor: { type: 'user', id: 'user-1' },
      ingress: { type: 'rule', id: 'ingress-1' },
      cause: 'test',
      causalChain: [],
      configVersion: 'test',
      item: {
        id: 'item-1',
        source: 'manual',
        sourceKey: 'source-1',
        parentWorkItemId: null,
        title: 'Loyalty program',
        url: null,
        stages: ['spec'],
        acceptedAt: null,
        metadata: {},
      },
      board: 'product',
      itemRevision: 1,
      source: 'manual',
      stage: 'spec',
      fromStage: 'intake',
      toStage: 'spec',
    } as unknown as FactoryStageRuleContext;
    const decision = await productBoard.rules.spec?.manual?.onEnter?.(context);
    expect(decision).toMatchObject({ type: 'invokeSkill', role: PRODUCT_CONTEXT, skillName: 'product-spec' });
  });
});
