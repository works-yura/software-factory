/**
 * Overlap policies: whether a fire goes ahead while the work of an earlier fire is still open.
 */

import type { BoardRegistry } from '@factory/core';
import type { WorkItemsStorage } from '@factory/store';

import type { IntakePolicyKind } from './kinds.ts';

export const SKIP_IF_OPEN_POLICY = 'skip-if-open';
export const ALWAYS_POLICY = 'always';

/** Skip while the last card a rule filed is still open (not in a terminal phase of its board). */
export function skipIfOpenPolicy(options: {
  workItems: Pick<WorkItemsStorage, 'get'>;
  boards: { load(scope: { orgId: string; factoryProjectId: string }): Promise<BoardRegistry> };
}): IntakePolicyKind {
  return {
    kind: SKIP_IF_OPEN_POLICY,
    label: { uk: 'Пропустити, поки попередня картка відкрита', en: 'Skip while the last card is open' },
    decide: async ({ rule, lastWork }) => {
      if (!lastWork?.workItemId) return { go: true };
      const card = await options.workItems.get({ orgId: rule.orgId, id: lastWork.workItemId });
      if (!card || card.stages.length !== 1) return { go: true };
      const registry = await options.boards.load(rule);
      const kind = card.board ? registry.get(card.board)?.phaseKind(card.stages[0]!) : undefined;
      if (kind === 'terminal' || kind === undefined) return { go: true };
      return { go: false, reason: `The card from the last fire («${card.title}») is still open.` };
    },
  };
}

/** Every fire goes ahead. */
export const alwaysPolicy: IntakePolicyKind = {
  kind: ALWAYS_POLICY,
  label: { uk: 'Запускати завжди', en: 'Always run' },
  decide: async () => ({ go: true }),
};
