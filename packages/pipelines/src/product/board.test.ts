import { describe, expect, it } from 'vitest';

import { FACTORY_RULE_SOURCES, phaseRunDecision } from '@factory/core';
import type { FactoryStageRuleContext } from '@factory/core';
import { createDefaultBoardRegistry, defaultBoards } from '../defaults.ts';
import { PRODUCT_CONTEXT, productBoard } from './board.ts';
import { PRODUCT_CHILDREN_KEY, PRODUCT_DOC_CHECKS_KEY } from './documents.ts';

function stageContext(
  fromStage: string,
  toStage: string,
  metadata: Record<string, unknown> = {},
  source = 'manual',
): FactoryStageRuleContext {
  return {
    tenant: { orgId: 'org-1', projectId: 'project-1' },
    actor: { type: 'human', id: 'user-1' },
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
      stages: [fromStage],
      acceptedAt: null,
      metadata,
    },
    board: 'product',
    itemRevision: 1,
    source,
    stage: toStage,
    fromStage,
    toStage,
  } as unknown as FactoryStageRuleContext;
}

const passedCheck = (type: string) => ({
  type,
  path: `docs/changes/2026-11-10-loyalty/${type}.md`,
  sha256: 'a'.repeat(64),
  passed: true,
  missingSections: [],
  missingDiagrams: [],
  contradictions: [],
  checkedAt: '2026-11-10T00:00:00.000Z',
});

describe('Product board', () => {
  it('is installed by default next to Work', () => {
    expect(defaultBoards.map(board => board.id)).toEqual(['work', 'product']);
    expect(createDefaultBoardRegistry().get('product')).toBe(productBoard);
    expect(createDefaultBoardRegistry({ includeDefaultBoards: false }).get('product')).toBeUndefined();
  });

  it('runs research, brief, spec and phases in one product session, and rests between them', () => {
    const kinds = Object.fromEntries(Object.entries(productBoard.phases).map(([id, phase]) => [id, phase.kind]));
    expect(kinds).toEqual({
      intake: 'resting',
      enrich: 'working',
      brief: 'working',
      'client-review': 'resting',
      spec: 'working',
      'spec-review': 'resting',
      phases: 'working',
      'phases-review': 'resting',
      done: 'terminal',
      canceled: 'terminal',
    });
    for (const [phase, skill] of [
      ['enrich', 'product-enrich'],
      ['brief', 'product-brief'],
      ['spec', 'product-spec'],
      ['phases', 'product-phases'],
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

  it('lets a card skip research or the brief, loop through revisions, and only finish after phases are checked', () => {
    const allowed = (from: string, to: string) => productBoard.allowsTransition(from as never, to as never);
    expect(allowed('intake', 'enrich')).toBe(true);
    expect(allowed('intake', 'brief')).toBe(true);
    expect(allowed('intake', 'spec')).toBe(true);
    expect(allowed('intake', 'phases')).toBe(false);
    expect(allowed('enrich', 'brief')).toBe(true);
    expect(allowed('enrich', 'spec')).toBe(true);
    expect(allowed('brief', 'client-review')).toBe(true);
    expect(allowed('client-review', 'brief')).toBe(true);
    expect(allowed('client-review', 'spec')).toBe(true);
    expect(allowed('spec', 'spec-review')).toBe(true);
    expect(allowed('spec-review', 'spec')).toBe(true);
    expect(allowed('spec-review', 'phases')).toBe(true);
    expect(allowed('phases', 'phases-review')).toBe(true);
    expect(allowed('phases-review', 'phases')).toBe(true);
    expect(allowed('phases-review', 'done')).toBe(true);
    expect(allowed('spec', 'done')).toBe(false);
    expect(allowed('phases', 'done')).toBe(false);
    expect(allowed('done', 'intake')).toBe(false);
    expect(allowed('canceled', 'intake')).toBe(true);
  });

  it("starts the phase's skill in the product session when a card enters a working phase", async () => {
    for (const [phase, skillName] of [
      ['enrich', 'product-enrich'],
      ['brief', 'product-brief'],
      ['spec', 'product-spec'],
      ['phases', 'product-phases'],
    ] as const) {
      const decision = phaseRunDecision(productBoard, phase, stageContext('intake', phase));
      expect(decision).toMatchObject({ type: 'invokeSkill', role: PRODUCT_CONTEXT, skillName });
    }
  });

  describe('gates', () => {
    // The gates are the board's transition policy: they hold a move whoever makes it, from any source.
    const exit = (_from: 'brief' | 'spec-review' | 'phases' | 'phases-review', _source = 'manual') => {
      const policy = productBoard.transitionPolicy;
      if (!policy) throw new Error('Product declares no gates');
      return async (context: FactoryStageRuleContext) => policy(context as never);
    };

    it('holds Phases until the spec check passed, for cards from every source', async () => {
      for (const source of FACTORY_RULE_SOURCES) {
        const refused = await exit('spec-review', source)(stageContext('spec-review', 'phases', {}, source));
        expect(refused).toMatchObject({ type: 'reject', code: 'invalid_transition' });
        expect((refused as { reason: string }).reason).toContain('factory_check_product_document');
      }
      const failed = await exit('spec-review')(
        stageContext('spec-review', 'phases', {
          [PRODUCT_DOC_CHECKS_KEY]: {
            spec: {
              ...passedCheck('spec'),
              passed: false,
              missingSections: ['Test plan'],
              missingDiagrams: ['sequence diagram'],
              contradictions: [{ finding: 'spec.md caches tokens; decisions/0003 forbids it', resolved: false }],
            },
          },
        }),
      );
      const reason = (failed as { reason: string }).reason;
      expect(reason).toContain('missing sections: Test plan');
      expect(reason).toContain('missing diagrams: sequence diagram');
      expect(reason).toContain('unresolved contradictions');
      await expect(
        exit('spec-review')(
          stageContext('spec-review', 'phases', { [PRODUCT_DOC_CHECKS_KEY]: { spec: passedCheck('spec') } }),
        ),
      ).resolves.toBeUndefined();
    });

    it('still honours checks recorded under an older layout, without rewriting them', async () => {
      // Cards checked before docs moved to features/<feature>/ keep their recorded path.
      for (const path of ['docs/specify/loyalty/design.md', 'docs/changes/2026-11-10-loyalty/spec.md']) {
        const metadata = { [PRODUCT_DOC_CHECKS_KEY]: { spec: { ...passedCheck('spec'), path } } };
        await expect(exit('spec-review')(stageContext('spec-review', 'phases', metadata))).resolves.toBeUndefined();
        expect(metadata[PRODUCT_DOC_CHECKS_KEY].spec.path).toBe(path);
      }
    });

    it('sends the brief for approval only once its check passed', async () => {
      await expect(exit('brief')(stageContext('brief', 'client-review'))).resolves.toMatchObject({ type: 'reject' });
      await expect(
        exit('brief')(
          stageContext('brief', 'client-review', { [PRODUCT_DOC_CHECKS_KEY]: { brief: passedCheck('brief') } }),
        ),
      ).resolves.toBeUndefined();
    });

    it('hands the phases to review only once the tasks check passed', async () => {
      const refused = await exit('phases')(stageContext('phases', 'phases-review'));
      expect(refused).toMatchObject({ type: 'reject', code: 'invalid_transition' });
      expect((refused as { reason: string }).reason).toContain('tasks.md');
      const failed = await exit('phases')(
        stageContext('phases', 'phases-review', {
          [PRODUCT_DOC_CHECKS_KEY]: {
            tasks: { ...passedCheck('tasks'), passed: false, taskProblems: ['LY-02 has no verify'] },
          },
        }),
      );
      expect((failed as { reason: string }).reason).toContain('task problems: LY-02 has no verify');
      await expect(
        exit('phases')(
          stageContext('phases', 'phases-review', { [PRODUCT_DOC_CHECKS_KEY]: { tasks: passedCheck('tasks') } }),
        ),
      ).resolves.toBeUndefined();
      await expect(exit('phases')(stageContext('phases', 'canceled'))).resolves.toBeUndefined();
    });

    it('lets a card go back for revisions or be canceled without a check', async () => {
      await expect(exit('brief')(stageContext('brief', 'canceled'))).resolves.toBeUndefined();
      await expect(exit('spec-review')(stageContext('spec-review', 'spec'))).resolves.toBeUndefined();
      await expect(exit('spec-review')(stageContext('spec-review', 'canceled'))).resolves.toBeUndefined();
      await expect(exit('phases-review')(stageContext('phases-review', 'phases'))).resolves.toBeUndefined();
    });

    it('holds Done until the card filed Development cards', async () => {
      await expect(exit('phases-review')(stageContext('phases-review', 'done'))).resolves.toMatchObject({
        type: 'reject',
      });
      await expect(
        exit('phases-review')(stageContext('phases-review', 'done', { [PRODUCT_CHILDREN_KEY]: ['child-1'] })),
      ).resolves.toBeUndefined();
    });
  });
});
