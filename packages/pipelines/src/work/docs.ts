/**
 * What the Development (Work) board asks of its agents about the project's documentation
 * (`docs/rules/docs-standard.md`, `docs/features/work-board/design.md`): read the truth before building, note deviations from a
 * Product change's design in the change request, keep the bug record, and — once per Product change —
 * merge the change's delta into `features/<area>/design.md` and archive the change.
 *
 * The merge runs on a card of its own, the docs-sync card the Product session files last under the
 * change (`productDocsSync`), so it goes through Planning, Building, review and merge like any other
 * task: a person starts it once the change's other cards are merged, and its pull or merge request is
 * the docs change. A close-out run on `done` would be cut short by terminal-stage cleanup, and a
 * "last sibling" check in a rule cannot see the other cards.
 */

import type { FactoryRuleItemContext } from '@factory/core';

/** Card metadata: the card is the change's docs-sync task. Set by the Product session's card tool. */
export const PRODUCT_DOCS_SYNC_KEY = 'productDocsSync';

/** Card metadata: the Product change folder (`<docs>/changes/<change>`) the card was filed from. */
export const PRODUCT_CHANGE_KEY = 'productChange';

/** The skill that reads and writes the project's documentation for Development, and runs the docs sync. */
export const DOCS_SKILL = 'factory-docs-sync';

/** Whether the card is a Product change's docs-sync task. */
export function isDocsSyncCard(item: Pick<FactoryRuleItemContext, 'metadata'>): boolean {
  return item.metadata?.[PRODUCT_DOCS_SYNC_KEY] === true;
}

/** The Product change folder the card was filed from, when the card records one. */
export function productChangeOf(item: Pick<FactoryRuleItemContext, 'metadata'>): string | undefined {
  const value = item.metadata?.[PRODUCT_CHANGE_KEY];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** The change folder that holds a recorded Product document, e.g. `docs/changes/2026-11-10-x/tasks.md` → `docs/changes/2026-11-10-x`. */
export function changeFolderOf(documentPath: string): string | undefined {
  const normalized = documentPath.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  const segments = normalized.split('/').filter(Boolean);
  // `…/changes/<change>/<file>` from any workspace or absolute prefix: the folder relative to the docs root,
  // which is what a Development session in another workspace can find.
  const at = segments.lastIndexOf('changes');
  if (at >= 0 && at + 2 < segments.length) return `changes/${segments[at + 1]}`;
  // Older layouts (`specify/<feature>/…`, `features/<feature>/spec.md`) keep the folder as recorded.
  const slash = normalized.lastIndexOf('/');
  return slash > 0 ? normalized.slice(0, slash) : undefined;
}

const READ_DOCS =
  `Before you change anything, read the project's documentation as \`references/project-docs.md\` of the ` +
  `\`${DOCS_SKILL}\` skill says (\`skill_read\`): find the docs folder, read \`features/<area>/design.md\` for the ` +
  'areas this work touches, `rules/`, and `bugs/INVARIANTS.md` when they exist. If you find no docs folder, say so ' +
  'in your handoff; never assume there is none.';

/** What every Development build is told about the project's documentation, by what the card is. */
export function buildDocsGuidance(item: FactoryRuleItemContext, { bugFix }: { bugFix: boolean }): string {
  const lines = [READ_DOCS];
  if (item.parentWorkItemId !== null) {
    const change = productChangeOf(item);
    lines.push(
      `This card is a task of a Product change${change ? ` (\`${change}/\`)` : ''}: build what its \`tasks.md\` task ` +
        'and the linked `design.md` sections say. Where the implementation has to differ from that design, do not ' +
        'edit the docs: add a `## Deviations from design` section to your change request body listing each ' +
        "difference and why (write `None` when there is none). The change's docs-sync task merges the design from " +
        'what was actually built.',
    );
  }
  if (bugFix) {
    lines.push(
      "This is a bug fix: keep the bug's record in the docs (`bugs/<id>.md`, format in `references/project-docs.md`). " +
        'If triage already added it on this branch, complete its fix and verification sections; if not, write the ' +
        'whole record. Commit it in the docs repository on this branch and open its change request beside the code.',
    );
  } else {
    lines.push(
      'If this branch already carries a bug record under `bugs/` in the docs (triage writes one for a confirmed bug), ' +
        'this is a bug fix: complete its fix and verification sections as `references/project-docs.md` says.',
    );
  }
  return lines.join('\n\n');
}

/** The docs-sync task's kickoff, for its Planning (`plan`) or Building (`apply`) run. */
export function docsSyncArguments(item: FactoryRuleItemContext, mode: 'plan' | 'apply'): string {
  const change = productChangeOf(item);
  return [
    `Mode: ${mode}.`,
    change
      ? `Product change folder: \`${change}/\`.`
      : 'This card records no Product change folder: find it from the card brief (its `changes/<change>/tasks.md` link) and say which one you used.',
    `Card: ${JSON.stringify(item.title)}.`,
  ].join('\n');
}
