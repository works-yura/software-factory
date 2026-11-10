import type { ExternalWorkItemSource } from '../card.ts';
import { factoryRuleStage, isTerminalFactoryRuleStage } from '../rules/types.ts';
import type { FactoryRuleBoardClosure, FactoryRuleChangeRequests, FactoryRulePhaseContext } from '../rules/types.ts';
import type {
  BoardEventIntegration,
  BoardEventRules,
  BoardPhaseKind,
  BoardToolResultRuleHandler,
} from './define-board.ts';
import type { BoardRegistry } from './registry.ts';

type BoardLookup = Pick<BoardRegistry, 'get'>;

/** Fields semantics reads off a stored card. */
type PhaseCard = {
  board: string | null;
  externalSource: ExternalWorkItemSource | null;
  stages: readonly string[];
};

export interface PhaseSemantics {
  readonly kind: BoardPhaseKind;
  /** Seat that carries a working phase; absent for resting and terminal phases. */
  readonly role?: string;
}

/**
 * Board that owns a work item. Rows created before boards were persisted carry no `board`; they
 * belong to Work. (Pull request cards among them belonged to the retired Review board; Factory
 * moves those onto Work at startup, see `moveReviewBoardCardsToWork`.)
 */
export function boardForWorkItem(item: Pick<PhaseCard, 'board'>): string {
  return item.board ?? 'work';
}

/**
 * A card that tracks a pull or merge request itself, as opposed to the card whose work opened it.
 * Both can sit on Work, so rules tell them apart by source rather than by board.
 */
export function isPullRequestCard(item: { readonly source: string }): boolean {
  return item.source === 'github-pr' || item.source === 'gitlab-pr';
}

/** Whether the rule's card is the change request's own card, which the reviewer reviews. */
export function reviewsPullRequest(context: {
  readonly board?: string;
  readonly item?: { readonly source: string };
}): boolean {
  return context.board === 'work' && context.item !== undefined && isPullRequestCard(context.item);
}

/**
 * The phase a pull or merge request's own card is reviewed in: Work's `pr-review`. Work's own
 * `review` phase is the builder's self-review, which a pull request card never enters.
 */
export const PULL_REQUEST_REVIEW_PHASE = 'pr-review';

/**
 * What the installed board says `phase` means. Returns undefined when the board is not
 * installed or does not declare the phase; callers must fail closed on undefined rather
 * than guess from the phase name.
 */
export function resolvePhaseSemantics(boards: BoardLookup, boardId: string, phase: string): PhaseSemantics | undefined {
  const board = boards.get(boardId);
  const kind = board?.phaseKind(phase);
  if (!board || !kind) return undefined;
  const role = board.roleForPhase(phase);
  return role === undefined ? { kind } : { kind, role };
}

/**
 * Tool-result rule the installed board declares for `toolName`. Undefined when the board is
 * not installed or declares no rule for the tool; callers must run nothing in that case.
 */
export function resolveBoardToolRule(
  boards: BoardLookup,
  boardId: string,
  toolName: string,
): BoardToolResultRuleHandler | undefined {
  return boards.get(boardId)?.tools[toolName]?.onResult;
}

/**
 * Integration event handlers the installed board declares for cards on it, or undefined when the
 * card is unbound, the board is not installed, or it declares none for this integration. Within the
 * map, `null` means the board switched that event off for its cards.
 */
export function boardEventHandlers<I extends BoardEventIntegration>(
  boards: BoardLookup,
  boardId: string | undefined,
  integration: I,
): BoardEventRules[I] | undefined {
  return boardId === undefined ? undefined : boards.get(boardId)?.events[integration];
}

/**
 * Board whose event handlers answer an integration evaluation: the bound card's board, except on
 * the evaluation that files a pull request's own Review card, which is about a card that does
 * not exist yet.
 */
export function eventBoardId(context: {
  readonly item?: unknown;
  readonly board?: string;
  readonly pullRequestIntake?: boolean;
}): string | undefined {
  return context.item && !context.pullRequestIntake ? context.board : undefined;
}

/** What a card's single current phase means on its installed board, for integration rule contexts. */
export function rulePhaseContext(boards: BoardLookup, item: PhaseCard): FactoryRulePhaseContext | undefined {
  const stage = factoryRuleStage(item.stages);
  if (stage === undefined) return undefined;
  const boardId = boardForWorkItem(item);
  const board = boards.get(boardId);
  const semantics = resolvePhaseSemantics(boards, boardId, stage);
  if (!board || !semantics) return undefined;
  const phase = board.phases[stage];
  return Object.freeze({
    id: stage,
    kind: semantics.kind,
    ...(semantics.role === undefined ? {} : { context: semantics.role, role: semantics.role }),
    nextPhases: Object.freeze([...(phase?.nextPhases ?? [])]),
    outcomes: Object.freeze(Object.keys(phase?.outcomes ?? {})),
  });
}

/**
 * Whether a persisted card has finished, judged by the board it sits on: the installed
 * board's phase kind first, then the built-in Work and Review names for rows whose board is
 * not installed. Unknown boards or phases are never terminal, so a card is only ever
 * released from ownership on the board's own say-so.
 */
export function isTerminalWorkItem(boards: BoardLookup, item: PhaseCard): boolean {
  const semantics = workItemPhaseSemantics(boards, item);
  if (semantics) return semantics.kind === 'terminal';
  const board = boardForWorkItem(item);
  return (board === 'work' || board === 'review') && isTerminalFactoryRuleStage(item.stages);
}

/** Semantics of the single stage a work item currently occupies; undefined for multi-stage rows. */
export function workItemPhaseSemantics(boards: BoardLookup, item: PhaseCard): PhaseSemantics | undefined {
  const stage = factoryRuleStage(item.stages);
  return stage === undefined ? undefined : resolvePhaseSemantics(boards, boardForWorkItem(item), stage);
}

/**
 * Where source-closed rules send a persisted card: the `sourceClosed` mapping its installed
 * board declares, plus whether the card already sits in a terminal phase. Undefined when the
 * board is not installed or declares no mapping, so closing the source leaves the card alone.
 */
export function resolveBoardClosure(boards: BoardLookup, item: PhaseCard): FactoryRuleBoardClosure | undefined {
  const board = boards.get(boardForWorkItem(item));
  if (!board?.sourceClosed) return undefined;
  const { completed, canceled } = board.sourceClosed;
  return {
    boardTitle: board.name,
    completed: { phase: completed, title: board.phases[completed]!.name },
    canceled: { phase: canceled, title: board.phases[canceled]!.name },
    itemTerminal: item.stages.some(stage => board.isTerminal(stage)),
  };
}

/** Rule-context fragment carrying the card's `boardClosure`, empty when the board declares none. */
export function withBoardClosure(boards: BoardLookup, item: PhaseCard): { boardClosure?: FactoryRuleBoardClosure } {
  const boardClosure = resolveBoardClosure(boards, item);
  return boardClosure ? { boardClosure } : {};
}

/**
 * The `changeRequests` flow the card's installed board declares, resolved to phase titles and the
 * builder seat. Undefined when the board is not installed or ships no change requests.
 */
export function resolveBoardChangeRequests(
  boards: BoardLookup,
  item: Pick<PhaseCard, 'board' | 'externalSource'>,
): FactoryRuleChangeRequests | undefined {
  const board = boards.get(boardForWorkItem(item));
  const flow = board?.changeRequests;
  if (!board || !flow) return undefined;
  const phase = (id: string) => ({ phase: id, title: board.phases[id]!.name });
  return {
    boardTitle: board.name,
    build: phase(flow.build),
    review: phase(flow.review),
    merged: phase(flow.merged),
    builderRole: board.roleForPhase(flow.build)!,
  };
}

/** Rule-context fragment carrying the card's `changeRequests`, empty when its board declares none. */
export function withChangeRequests(
  boards: BoardLookup,
  item: Pick<PhaseCard, 'board' | 'externalSource'>,
): { changeRequests?: FactoryRuleChangeRequests } {
  const changeRequests = resolveBoardChangeRequests(boards, item);
  return changeRequests ? { changeRequests } : {};
}

/** Whether the card's installed board has its `triage` seat report a structured classification. */
export function boardClassifiesTriage(boards: BoardLookup, item: Pick<PhaseCard, 'board' | 'externalSource'>): boolean {
  return boards.get(boardForWorkItem(item))?.triageClassification === true;
}

/** `{ phase }` for spreading into an integration rule context, or `{}` when the phase is unknown. */
export function rulePhaseField(boards: BoardLookup, item: PhaseCard): { readonly phase?: FactoryRulePhaseContext } {
  const phase = rulePhaseContext(boards, item);
  return phase ? { phase } : {};
}
