import { describe, expect, it } from 'vitest';

import type { FactoryRuleItemContext } from '@factory/core';
import { providerWorkItemForTests } from '../testing.ts';
import {
  buildDocsGuidance,
  changeFolderOf,
  docsSyncArguments,
  isDocsSyncCard,
  PRODUCT_CHANGE_KEY,
  PRODUCT_DOCS_SYNC_KEY,
} from './docs.ts';

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

const CHANGE = 'docs/changes/2026-11-10-loyalty';
const productTask = item({ parentWorkItemId: 'product-1', metadata: { repository: 'acme/api', [PRODUCT_CHANGE_KEY]: CHANGE } });
const docsSync = item({
  title: 'LY-DOCS — Merge into features',
  parentWorkItemId: 'product-1',
  metadata: { repository: 'acme/docs', [PRODUCT_CHANGE_KEY]: CHANGE, [PRODUCT_DOCS_SYNC_KEY]: true },
});

// Kickoffs only name the card; this guidance reaches the agent through the factory-work-item signal.
describe('Work board and the project documentation', () => {
  it('gives a Product change docs-sync task the docs skill arguments: the merge plan, then the merge', () => {
    const plan = docsSyncArguments(docsSync, 'plan');
    expect(plan).toContain('Mode: plan.');
    expect(plan).toContain(`\`${CHANGE}/\``);
    expect(docsSyncArguments(docsSync, 'apply')).toContain('Mode: apply.');
    expect(isDocsSyncCard(docsSync)).toBe(true);
    expect(isDocsSyncCard(productTask)).toBe(false);
  });

  it("tells every build to read the docs' truth first and never to assume there are none", () => {
    const guidance = buildDocsGuidance(item(), { bugFix: false });
    expect(guidance).toContain('`features/<area>/design.md`');
    expect(guidance).toContain('references/project-docs.md');
    expect(guidance).toContain('If you find no docs folder, say so in your handoff');
    // Not a Product task: nothing about deviations.
    expect(guidance).not.toContain('Deviations from design');
  });

  it("asks a Product change's task to report its deviations in the change request, not to edit the docs", () => {
    const guidance = buildDocsGuidance(productTask, { bugFix: false });
    expect(guidance).toContain(`\`${CHANGE}/\``);
    expect(guidance).toContain('## Deviations from design');
    expect(guidance).toContain('do not edit the docs');
  });

  it('asks a fix to keep the bug record, and a planned build to complete one triage started', () => {
    expect(buildDocsGuidance(item(), { bugFix: true })).toContain('`bugs/<id>.md`');
    expect(buildDocsGuidance(item(), { bugFix: false })).toContain(
      'If this branch already carries a bug record under `bugs/`',
    );
  });

  it('reads the change folder from a recorded document path', () => {
    // Relative to the docs root, whatever workspace or absolute prefix the agent typed.
    expect(changeFolderOf('docs/changes/2026-11-10-loyalty/tasks.md')).toBe('changes/2026-11-10-loyalty');
    expect(changeFolderOf('/workspace/acme-docs/changes/2026-11-10-loyalty/design.md')).toBe('changes/2026-11-10-loyalty');
    expect(changeFolderOf('syncta-docs\\changes\\2026-11-10-loyalty\\tasks.md')).toBe('changes/2026-11-10-loyalty');
    // Older layouts keep the folder as recorded.
    expect(changeFolderOf('docs/specify/loyalty/tasks.md')).toBe('docs/specify/loyalty');
    expect(changeFolderOf('tasks.md')).toBeUndefined();
  });
});
