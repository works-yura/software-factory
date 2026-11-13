import type { CardMoveStore, PipelineCard } from '../card.ts';
import { cardRuleFacts } from './card-facts.ts';
import type { FactsCard } from './card-facts.ts';
import type { IntakeRoute } from './intake-routing.ts';
import { resolveIntakePlacement } from './intake-routing.ts';
import type { BoardRegistry } from './registry.ts';
import { moveCardToBoard } from './relocate.ts';
import { boardForWorkItem } from './semantics.ts';

/** A card a reroute moves: from the board it is on to the start of the one the routes now file it on. */
export type RerouteMove<Card extends PipelineCard & FactsCard = PipelineCard & FactsCard> = {
  item: Card;
  fromBoard: string;
  toBoard: string;
  toPhase: string;
  routeId: string;
};

/**
 * A card nobody has worked yet: it sits alone in its board's first phase with no session on it.
 * Only such cards follow a change to the intake routes; anything further along stays put.
 */
function untouched(item: PipelineCard, registry: BoardRegistry): boolean {
  const board = registry.get(boardForWorkItem(item));
  if (!board) return false;
  return item.stages.length === 1 && item.stages[0] === board.initialPhase && Object.keys(item.sessions).length === 0;
}

/**
 * Which untouched cards the routes, as they stand, would file on a different board. Each lands at
 * the start of its new board. A card no route places stays where it is; a route «За розкладом»
 * places no card that arrives, so it moves none either.
 */
export function planReroute<Card extends PipelineCard & FactsCard>(
  routes: readonly IntakeRoute[],
  items: readonly Card[],
  registry: BoardRegistry,
): RerouteMove<Card>[] {
  const moves: RerouteMove<Card>[] = [];
  for (const item of items) {
    if (!untouched(item, registry)) continue;
    const placement = resolveIntakePlacement(routes, cardRuleFacts(item), registry);
    if (!placement) continue;
    const fromBoard = boardForWorkItem(item);
    if (placement.board === fromBoard) continue;
    const target = registry.get(placement.board)!;
    moves.push({ item, fromBoard, toBoard: placement.board, toPhase: target.initialPhase, routeId: placement.routeId });
  }
  return moves;
}

/** How many cards a plan moves from each board to each other board. */
export function summarizeReroute(
  moves: readonly Pick<RerouteMove, 'fromBoard' | 'toBoard'>[],
): { fromBoard: string; toBoard: string; count: number }[] {
  const counts = new Map<string, { fromBoard: string; toBoard: string; count: number }>();
  for (const { fromBoard, toBoard } of moves) {
    const key = `${fromBoard}\u0000${toBoard}`;
    const entry = counts.get(key) ?? { fromBoard, toBoard, count: 0 };
    entry.count += 1;
    counts.set(key, entry);
  }
  return [...counts.values()];
}

/** Moves each planned card; one that changed since the plan (a run started, someone moved it) is skipped. */
export async function applyReroute({
  moves,
  workItems,
  registry,
  userId,
}: {
  moves: readonly RerouteMove[];
  workItems: CardMoveStore;
  registry: BoardRegistry;
  userId: string;
}): Promise<{ moved: number; skipped: number }> {
  let moved = 0;
  let skipped = 0;
  for (const move of moves) {
    const result = await moveCardToBoard({
      workItems,
      boardRegistry: registry,
      userId,
      item: move.item,
      targetBoard: move.toBoard,
      targetStage: move.toPhase,
    });
    if (result === 'moved') moved += 1;
    else skipped += 1;
  }
  return { moved, skipped };
}
