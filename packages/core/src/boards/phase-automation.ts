import type { ExternalWorkItemSource } from '../card.ts';
import { evaluateRuleGroup } from '../rules/rule-group.ts';
import type { FactoryCommitDecision } from '../rules/types.ts';
import { cardRuleFacts } from './card-facts.ts';
import type { CardSourceFacts } from './card-facts.ts';
import type { BoardRegistry } from './registry.ts';
import { codeBoardOf } from './define-board.ts';
import { boardForWorkItem } from './semantics.ts';

const WORK_BOARD_KEY = 'work';

type Card = {
  readonly board: string | null;
  readonly externalSource: ExternalWorkItemSource | null;
  readonly stages: readonly string[];
  readonly title: string;
  readonly metadata: Record<string, unknown> | null;
  readonly workItem?: CardSourceFacts;
};

/**
 * Whether the decision starts the run of a phase that starts on its own for this card
 * (`autoStart`, and `autoStartWhen` when set), so it needs nobody's approval.
 */
export function startsInAutoPhase(boards: BoardRegistry, item: Card, decision: FactoryCommitDecision): boolean {
  if (decision.type === 'transition') {
    return boards.get(decision.board)?.startsAutomatically(decision.stage, cardRuleFacts(item)) === true;
  }
  if (decision.type !== 'invokeSkill' || item.stages.length !== 1) return false;
  const boardKey = boardForWorkItem(item);
  const board = boards.get(boardKey);
  const stage = item.stages[0]!;
  if (!board) return false;
  // Work's Review and PR review phases run the independent reviewer in its own `review` seat. The Work
  // board lives in `@factory/pipelines`, which core cannot import, so it is known by its code board's key.
  const reviewerSeat =
    decision.role === 'review' &&
    codeBoardOf(board).id === WORK_BOARD_KEY &&
    (stage === 'review' || stage === 'pr-review');
  const ownRun = board.roleForPhase(stage) === decision.role || reviewerSeat;
  return ownRun && board.startsAutomatically(stage, cardRuleFacts(item));
}

/** The exit tool of the card's phase when it is approved without a person for this card. */
export function autoApprovedExitTool(boards: BoardRegistry, item: Card): string | undefined {
  if (item.stages.length !== 1) return undefined;
  const phase = boards.get(boardForWorkItem(item))?.phases[item.stages[0]!];
  if (phase?.kind !== 'working' || !phase.exitTool?.autoApprove) return undefined;
  return evaluateRuleGroup(phase.exitTool.autoApproveWhen, cardRuleFacts(item)) ? phase.exitTool.id : undefined;
}
