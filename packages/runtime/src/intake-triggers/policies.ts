import { externalSourceForWorkItem } from '@factory/core';
import type { BoardRegistry, ExternalWorkItemSource, IntakePolicyKind, IntakeScope } from '@factory/core';

/**
 * The built-in overlap policies of trigger routes. A policy is told the route's last fire that
 * went ahead and says whether this fire may.
 */

export const SKIP_IF_OPEN_POLICY = 'skip-if-open';
export const ALWAYS_POLICY = 'always';

/** Finds the card a fire filed, by the source it was filed under (`intake-route`, `<routeId>:<fireKey>`). */
export interface IntakeCardReader {
  getByProjectSource(input: {
    orgId: string;
    factoryProjectId: string;
    source: ExternalWorkItemSource;
  }): Promise<{ id: string; title: string; board?: string | null; stages: readonly string[] } | null>;
}

export interface IntakeBoardsLoader {
  load(scope: IntakeScope): Promise<BoardRegistry>;
}

/** The source a trigger route's card is filed under: one per route and fire. */
export function intakeRouteCardSource(routeId: string, fireKey: string): ExternalWorkItemSource {
  return externalSourceForWorkItem('intake-route', `${routeId}:${fireKey}`);
}

/**
 * Skips a fire while the card the last fire filed is still open (not in a terminal phase), naming
 * that card on the skipped fire. A last fire whose card isn't there (deleted, or never filed)
 * doesn't hold the next one back.
 */
export function skipIfOpenPolicy(options: { cards: IntakeCardReader; boards: IntakeBoardsLoader }): IntakePolicyKind {
  return {
    kind: SKIP_IF_OPEN_POLICY,
    label: { uk: 'Пропустити, поки попередня картка відкрита', en: 'Skip while the last card is open' },
    decide: async ({ route, lastWork }) => {
      if (!lastWork?.fireKey) return { go: true };
      const card = await options.cards.getByProjectSource({
        orgId: route.orgId,
        factoryProjectId: route.factoryProjectId,
        source: intakeRouteCardSource(route.id, lastWork.fireKey),
      });
      if (!card || card.stages.length !== 1) return { go: true };
      const registry = await options.boards.load(route);
      const kind = card.board ? registry.get(card.board)?.phaseKind(card.stages[0]!) : undefined;
      if (kind === 'terminal' || kind === undefined) return { go: true };
      return { go: false, reason: `The card from the last fire («${card.title}») is still open.`, workItemId: card.id };
    },
  };
}

export const alwaysPolicy: IntakePolicyKind = {
  kind: ALWAYS_POLICY,
  label: { uk: 'Запускати завжди', en: 'Always run' },
  decide: async () => ({ go: true }),
};
