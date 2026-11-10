import { FACTORY_ROLE_STAGES, needsApproval } from '@factory/core/rules/types';
import type { FactoryRole, FactoryRuleStage } from '@factory/core/rules/types';
import type { BoardCardState, BoardCardStatus } from './boardCardState';
import { itemSessionSpec, metadataLabels, pullRequestStatusForItem, pullRequestStatusForSource } from './boardItems';
import { attachedPullRequestSource, cardHasPullRequest, isPullRequestSource } from './services/workItems';
import type { WorkItem, WorkItemSessionRef } from './services/workItems';
import { translator } from '../../i18n/t';
import { isTerminalStage } from './stages';
import type { BoardStageId } from './stages';

export interface CardPrimaryAction {
  label: string;
  /** Spoken name when the pill's label is abbreviated to fit the actions row. */
  ariaLabel?: string;
  start: () => void;
}

/** A lane the card can be moved into, named by what the lane's rule then runs. */
export type CardMoveAction = 'investigate' | 'plan' | 'build' | 'prepareApproval' | 'review' | 'reReview';

export interface CardMove {
  /** Stable id of the lane's verb; picks the icon whatever language the label is in. */
  action: CardMoveAction;
  /** Translated when read: the lane's verb, e.g. "Investigate" or "Build". */
  readonly label: string;
  /** Session slot the lane's run fills on the card, e.g. `plan` or `work`. */
  role: FactoryRole;
  stage: FactoryRuleStage;
  /** The run's outcome is a maintainer decision, so hands-off has nothing to remove. */
  awaitsHumanDecision?: true;
}

/** A persisted card or a candidate feed entry: both are moved by the same lane rules. */
export type MovableCard = Pick<WorkItem, 'source' | 'metadata' | 'workItem'> &
  Partial<Pick<WorkItem, 'board' | 'stages'>>;

const tk = translator('board');

const INVESTIGATE: CardMove = {
  action: 'investigate',
  get label() {
    return tk('moves.investigate');
  },
  role: 'triage',
  stage: 'triage',
};
const BUILD: CardMove = {
  action: 'build',
  get label() {
    return tk('moves.build');
  },
  role: 'work',
  stage: 'execute',
};
const PLAN: CardMove = {
  action: 'plan',
  get label() {
    return tk('moves.plan');
  },
  role: 'work',
  stage: 'planning',
};

/** An issue card's moves from each column, following the Work board's `nextPhases`: Building comes only after Planning. */
function issueMoves(columnStage: BoardStageId): CardMove[] {
  if (columnStage === 'planning') return [PLAN, BUILD];
  if (columnStage === 'execute') return [BUILD, PLAN];
  return [INVESTIGATE, PLAN];
}
const PREPARE_APPROVAL: CardMove = {
  action: 'prepareApproval',
  get label() {
    return tk('moves.prepareApproval');
  },
  role: 'triage',
  stage: 'triage',
  awaitsHumanDecision: true,
};
/** A card's pull request, its own or one attached to its issue, is reviewed in Work's PR review. */
const REVIEW: CardMove = {
  action: 'review',
  get label() {
    return tk('moves.review');
  },
  role: 'review',
  stage: 'pr-review',
};
const RE_REVIEW: CardMove = {
  action: 'reReview',
  get label() {
    return tk('moves.reReview');
  },
  role: 'review',
  stage: 'pr-review',
};

/** Where a card's button can send it, likeliest first; the lane's rule decides what runs there. */
export function cardMoves(item: MovableCard, columnStage: BoardStageId): CardMove[] {
  if (item.board != null && item.board !== 'work') return [];
  if (isTerminalStage(columnStage)) return openPullRequestInDone(item, columnStage) ? [RE_REVIEW] : [];
  // A card carrying a pull request, its own or one attached to its issue, sends it to PR review.
  if ((columnStage === 'pr-review' || columnStage === 'review') && cardHasPullRequest(item)) return [REVIEW];
  if (columnStage === 'review') return [];
  if (item.source === 'github-issue') {
    return needsApproval({ ...item, workItem: item.workItem ?? { labels: metadataLabels(item.metadata) } })
      ? [PREPARE_APPROVAL]
      : issueMoves(columnStage);
  }
  if (item.source === 'gitlab-issue') {
    return issueMoves(columnStage);
  }
  return isPullRequestSource(item.source) ? [REVIEW] : [];
}

function openPullRequestInDone(item: MovableCard, columnStage: BoardStageId): boolean {
  if (columnStage !== 'done' || !cardHasPullRequest(item)) return false;
  // An issue card's pull request state lives on the pull request's source, not the issue's.
  const attached = attachedPullRequestSource(item);
  const status = attached
    ? pullRequestStatusForSource(attached)
    : pullRequestStatusForItem({ ...item, stages: item.stages ?? [] });
  return status === 'open' || status === 'draft';
}

// PR review carries a pull request card's reviewer, after the builder's lanes.
const WORKING_LANES: readonly FactoryRuleStage[] = [...Object.values(FACTORY_ROLE_STAGES), 'pr-review'];

/**
 * Resume re-enters the deepest working lane a card parked in Intake has been in, and lets
 * that lane's rule dispatch. Phases can share a session, so the lane comes from the card's
 * stage history; a card that never had a session is a fresh arrival with nothing to resume.
 */
export function resumeStage(
  columnStage: BoardStageId,
  item: {
    /** The card's resolved board (`itemBoard`): a legacy card with no board sits on Work. */
    board: string;
    sessions: Record<string, WorkItemSessionRef>;
    stageHistory?: readonly { stage: string }[];
  },
): FactoryRuleStage | undefined {
  if (columnStage !== 'intake' || Object.keys(item.sessions).length === 0) return undefined;
  const visited = new Set((item.stageHistory ?? []).map(entry => entry.stage));
  const lane = WORKING_LANES.filter(lane => visited.has(lane)).at(-1);
  // On Work, Intake leads to neither Building nor its self-review: a card that got that far
  // resumes in Planning. A pull request card resumes in PR review.
  return item.board === 'work' && (lane === 'execute' || lane === 'review') ? 'planning' : lane;
}

/**
 * Triage looked at the card and left it in Intake, so the next move is a
 * person's decision. The card then asks for that decision instead of offering
 * a run that would only advance it as a side effect. A card that has been past
 * Triage since (a parked build, say) resumes instead.
 */
export function awaitsTriageDecision(
  item: Pick<WorkItem, 'sessions'> & Partial<Pick<WorkItem, 'board' | 'stageHistory'>>,
  columnStage: BoardStageId,
) {
  return (
    (item.board == null || item.board === 'work') &&
    columnStage === 'intake' &&
    item.sessions.triage !== undefined &&
    (resumeStage(columnStage, { ...item, board: 'work' }) ?? 'triage') === 'triage'
  );
}

export interface TriageDecision {
  readonly label: string;
  stage: 'planning' | 'canceled';
}

/** The maintainer's choices for a held card, the likeliest first. */
export const TRIAGE_DECISIONS: readonly TriageDecision[] = [
  {
    get label() {
      return tk('triageDecisions.acceptAndPlan');
    },
    stage: 'planning',
  },
  {
    get label() {
      return tk('triageDecisions.close');
    },
    stage: 'canceled',
  },
];

/**
 * A held card's primary action is the maintainer's decision, ahead of
 * everything else: a suggested or parked run would advance the card without
 * that decision being made. Otherwise a proposed run wins the slot, since
 * releasing it beats starting a rival run beside it, and resuming parked work
 * comes next for the same reason.
 */
export function cardPrimaryAction({
  item,
  columnStage,
  move,
  resumeStage,
  nextPhase,
  waiting,
  hasSession,
  onApproveProposal,
  onCreateSession,
  onMove,
}: {
  item: WorkItem;
  columnStage?: BoardStageId;
  /** The lane the button sends the card to; undefined when the card has none to offer. */
  move?: CardMove;
  /** Lane a parked card goes back to, ahead of any move it also offers. */
  resumeStage?: FactoryRuleStage;
  /** On a custom board, the first phase this one declares a transition to. */
  nextPhase?: { id: string; label: string };
  /** The card's own parked run, read from its status so the button says what the badge says. */
  waiting?: { label: string; decisionId: string };
  hasSession: boolean;
  onApproveProposal: (decisionId: string) => void;
  onCreateSession: (spec: { branch: string; threadTitle: string }) => void;
  onMove: (toStage: string) => void;
}): CardPrimaryAction | undefined {
  if (columnStage !== undefined && awaitsTriageDecision(item, columnStage)) {
    // One word on the pill so it sits beside "Open session"; the menu spells out the alternatives.
    const [accept] = TRIAGE_DECISIONS;
    return { label: tk('primaryAction.accept'), ariaLabel: accept.label, start: () => onMove(accept.stage) };
  }
  if (waiting !== undefined) {
    return { label: waiting.label, start: () => onApproveProposal(waiting.decisionId) };
  }
  if (resumeStage !== undefined) {
    return { label: tk('primaryAction.resume'), start: () => onMove(resumeStage) };
  }
  if (move !== undefined) {
    return { label: move.label, start: () => onMove(move.stage) };
  }
  // A custom board's phases carry their own runs, so the button advances the card rather than starting one.
  if (nextPhase !== undefined) {
    return { label: tk('primaryAction.moveTo', { phase: nextPhase.label }), start: () => onMove(nextPhase.id) };
  }
  // Every lane this card offers is already its own, so opening its session is the action.
  if (hasSession) return undefined;
  return {
    label: tk('primaryAction.startSession'),
    start: () => onCreateSession(itemSessionSpec(item)),
  };
}

export type CardAction = { label: string; ariaLabel?: string; disabled?: boolean; urgent?: boolean } & (
  | { href: string }
  | { start: () => void }
);

export function sessionLink(href: string | undefined): CardAction | undefined {
  return href === undefined ? undefined : { label: tk('primaryAction.openSession'), href };
}

export function retryButton({
  decisionId,
  onRetry,
  onChooseRepository,
}: {
  decisionId?: string;
  onRetry: (decisionId: string) => void;
  /** Set when the run failed for want of the card's repository: the button asks for it, then retries. */
  onChooseRepository?: (decisionId: string) => void;
}): CardPrimaryAction | undefined {
  if (decisionId === undefined) return undefined;
  if (onChooseRepository) return { label: tk('primaryAction.chooseRepository'), start: () => onChooseRepository(decisionId) };
  return { label: tk('primaryAction.retry'), start: () => onRetry(decisionId) };
}

/** The card's buttons, the likeliest next click first; `urgent` marks the one the card waits on a person for. */
export function cardActions({
  state,
  session,
  retry,
  run,
}: {
  state: BoardCardState;
  session?: CardAction;
  retry?: CardPrimaryAction;
  run?: CardPrimaryAction;
}): CardAction[] {
  const { owner } = state;
  if (owner.kind === 'free') return freeCardActions(state.status, { session, retry, run });
  if (session !== undefined) return [session];
  if (owner.kind === 'session' || run === undefined) return [];
  return [{ label: owner.progressLabel, start: run.start, disabled: true }];
}

function freeCardActions(
  status: BoardCardStatus,
  { session, retry, run }: { session?: CardAction; retry?: CardPrimaryAction; run?: CardPrimaryAction },
): CardAction[] {
  const namedRun =
    run !== undefined && status.kind === 'waiting'
      ? { ...run, ariaLabel: tk('primaryAction.startSuggestedRun', { label: status.label }) }
      : run;
  const main = retry ?? namedRun ?? session;
  if (main === undefined) return [];
  const awaitsPerson = status.kind === 'waiting' || status.kind === 'held';
  const isUrgent = (action: CardAction) => action === retry || (awaitsPerson && action === namedRun);
  const rest = [session, namedRun].filter(action => action !== undefined).filter(action => action !== main);
  return [main, ...rest].map(action => ({ ...action, urgent: isUrgent(action) }));
}
