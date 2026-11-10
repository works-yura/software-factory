/**
 * Overlap policies (Strategy): whether a fire goes ahead while the work of an earlier fire is
 * still open. They read the card the last fire made through narrow ports, never the store itself.
 */

import type { BoardRegistry, IntakePolicyKind, IntakeRuleScope } from '@factory/core';

export const SKIP_IF_OPEN_POLICY = 'skip-if-open';
export const ALWAYS_POLICY = 'always';

/** Reads one card; `WorkItemsStorage` implements it. */
export interface IntakeCardReader {
  get(input: { orgId: string; id: string }): Promise<{ title: string; board?: string | null; stages: readonly string[] } | null>;
}

/** A project's boards, stored ones included. */
export interface IntakeBoardsLoader {
  load(scope: IntakeRuleScope): Promise<BoardRegistry>;
}

/** Skip while the last card a rule filed is still open (not in a terminal phase of its board). */
export function skipIfOpenPolicy(options: { cards: IntakeCardReader; boards: IntakeBoardsLoader }): IntakePolicyKind {
  return {
    kind: SKIP_IF_OPEN_POLICY,
    label: { uk: 'Пропустити, поки попередня картка відкрита', en: 'Skip while the last card is open' },
    decide: async ({ rule, lastWork }) => {
      if (!lastWork?.workItemId) return { go: true };
      const card = await options.cards.get({ orgId: rule.orgId, id: lastWork.workItemId });
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
