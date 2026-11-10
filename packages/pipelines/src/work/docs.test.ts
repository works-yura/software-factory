import { describe, expect, it } from 'vitest';

import type { FactoryRuleItemContext, FactoryStageRuleContext, FactoryToolResultRuleContext } from '@factory/core';
import { providerWorkItemForTests } from '../testing.ts';
import { workBoard } from './board.ts';
import { changeFolderOf, DOCS_SKILL, PRODUCT_CHANGE_KEY, PRODUCT_DOCS_SYNC_KEY } from './docs.ts';
import { openApprovedChangeRequest } from './tool-rules.ts';

function item(overrides: Partial<FactoryRuleItemContext> = {}): FactoryRuleItemContext {
  return {
    id: 'item-1',
    source: 'manual',
    sourceKey: null,
    parentWorkItemId: null,
    title: 'LY-01 — Points API',
    url: null,
    stages: ['execute'],
    acceptedAt: null,
    metadata: {},
    workItem: providerWorkItemForTests({ provider: 'github', key: 'item-1', metadata: {} }),
    ...overrides,
  };
}

function stageContext(
  stage: 'planning' | 'execute',
  fromStage: string,
  card: FactoryRuleItemContext,
): FactoryStageRuleContext {
  return {
    tenant: { orgId: 'org-1', projectId: 'project-1' },
    actor: { type: 'human', id: 'user-1' },
    ingress: { type: 'human', id: 'ingress-1' },
    cause: 'test',
    causalChain: [],
    configVersion: 'test',
    item: { ...card, stages: [stage] },
    board: 'work',
    itemRevision: 1,
    source: 'manual',
    stage,
    fromStage,
    toStage: stage,
    selfReviewEnabled: true,
  };
}

const CHANGE = 'docs/changes/2026-11-10-loyalty';
const productTask = item({ parentWorkItemId: 'product-1', metadata: { repository: 'acme/api', [PRODUCT_CHANGE_KEY]: CHANGE } });
const docsSync = item({
  title: 'LY-DOCS — Merge into features',
  parentWorkItemId: 'product-1',
  metadata: { repository: 'acme/docs', [PRODUCT_CHANGE_KEY]: CHANGE, [PRODUCT_DOCS_SYNC_KEY]: true },
});

async function enter(stage: 'planning' | 'execute', fromStage: string, card: FactoryRuleItemContext) {
  const decision = await workBoard.rules[stage]?.manual?.onEnter?.(stageContext(stage, fromStage, card));
  if (!decision || decision.type !== 'invokeSkill') throw new Error(`Expected a skill invocation in ${stage}.`);
  return decision;
}

describe('Work board and the project documentation', () => {
  it('runs the docs skill on a Product change docs-sync task: the merge plan in Planning, the merge in Building', async () => {
    const plan = await enter('planning', 'intake', docsSync);
    expect(plan).toMatchObject({ role: 'work', skillName: DOCS_SKILL });
    expect(plan.arguments).toContain('Mode: plan.');
    expect(plan.arguments).toContain(`\`${CHANGE}/\``);

    const apply = await enter('execute', 'planning', docsSync);
    expect(apply).toMatchObject({ role: 'work', skillName: DOCS_SKILL, startsAfterOwnMove: true });
    expect(apply.arguments).toContain('Mode: apply.');
    // It hands on like any build: to self-review first when that is on.
    expect(apply.arguments).toContain('stage `review`');
  });

  it('plans and builds every other card as before, with factory-plan and the build prompt', async () => {
    expect(await enter('planning', 'intake', productTask)).toMatchObject({ skillName: 'factory-plan' });
    const build = await enter('execute', 'planning', productTask);
    expect(build.skillName).toBeUndefined();
    expect(build.prompt).toContain('Implement the approved plan for the work item.');
  });

  it("tells every build to read the docs' truth first and never to assume there are none", async () => {
    const build = await enter('execute', 'planning', item());
    expect(build.prompt).toContain('`features/<area>/design.md`');
    expect(build.prompt).toContain('references/project-docs.md');
    expect(build.prompt).toContain('If you find no docs folder, say so in your handoff');
    // Not a Product task: nothing about deviations.
    expect(build.prompt).not.toContain('Deviations from design');
  });

  it("asks a Product change's task to report its deviations in the change request, not to edit the docs", async () => {
    const build = await enter('execute', 'planning', productTask);
    expect(build.prompt).toContain(`\`${CHANGE}/\``);
    expect(build.prompt).toContain('## Deviations from design');
    expect(build.prompt).toContain('do not edit the docs');
  });

  it('asks a fix without a plan to keep the bug record, and a planned build to complete one triage started', async () => {
    const fix = await enter('execute', 'triage', item());
    expect(fix.prompt).toContain('This is a bug fix');
    expect(fix.prompt).toContain('`bugs/<id>.md`');
    const planned = await enter('execute', 'planning', item());
    expect(planned.prompt).toContain('If this branch already carries a bug record under `bugs/`');
  });

  it("reminds the builder of a Product change's task to report deviations when self-review approves", () => {
    const context = (parentWorkItemId: string | null): FactoryToolResultRuleContext =>
      ({
        tenant: { orgId: 'org-1', projectId: 'project-1' },
        actor: { type: 'agent', bindingId: 'binding-1', role: 'review' },
        ingress: { type: 'toolResult', id: 'tool-1' },
        cause: 'test',
        causalChain: [],
        configVersion: 'test',
        item: { ...item({ parentWorkItemId }), stages: ['review'], metadata: { selfReviewVerdict: 'approve' } },
        board: 'work',
        itemRevision: 1,
        toolName: 'factory_record_review_verdict',
        threadId: 'thread-1',
        assistantMessageId: 'message-1',
        toolCallId: 'call-1',
        result: { status: 'success', value: 'ok' },
      }) as FactoryToolResultRuleContext;
    const withParent = openApprovedChangeRequest(context('product-1'));
    expect(withParent?.prompt).toContain('## Deviations from design');
    expect(openApprovedChangeRequest(context(null))?.prompt).not.toContain('Deviations from design');
  });

  it('reads the change folder from a recorded document path', () => {
    expect(changeFolderOf('docs/changes/2026-11-10-loyalty/tasks.md')).toBe(CHANGE);
    expect(changeFolderOf('tasks.md')).toBeUndefined();
  });
});
