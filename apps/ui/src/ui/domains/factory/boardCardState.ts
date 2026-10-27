import type { InstalledPhaseInfo } from '../../../api/types';
import type { SessionRowStatus } from '../workspaces/services/sessionStatus';
import { translator } from '../../i18n/t';
import type { FactoryDecisionSummary } from './services/decisions';

const tk = translator('board');

/** A card has one status row, so every announcement it could make resolves to one of these. */
export type BoardCardStatus =
  | { kind: 'idle' }
  | { kind: 'waiting'; label: string; decisionId: string }
  /** Triage classed the card as non-bug work, so it waits on a maintainer's call. */
  | { kind: 'held'; label: string }
  | { kind: 'busy'; label: string }
  | { kind: 'error'; label: string; detail?: string; retryDecisionId?: string };

export type BoardCardOwner =
  | { kind: 'free' }
  | { kind: 'you'; progressLabel: string }
  | { kind: 'automation'; progressLabel: string }
  | { kind: 'session'; status: SessionRowStatus };

export interface BoardCardState {
  status: BoardCardStatus;
  owner: BoardCardOwner;
  wick?: SessionRowStatus;
}

export interface BoardCardStateInput {
  /** Run a rule parked on this card, held until someone releases it. */
  proposal?: { label: string; decisionId: string };
  /** Destination of an in-flight stage move. */
  moving?: { stage: string; label: string };
  /** Status text for the window between the click and the session mutation. */
  preparing?: string;
  retryRequested?: boolean;
  /** Rule effect the server is still working through, or gave up on. */
  decision?: FactoryDecisionSummary;
  /** Why the server refused the last move. */
  transitionReason?: string;
  /** What the run registry and workspace records say about the card's bound sessions. */
  sessionStatus?: SessionRowStatus;
  /** Triage classification a person still has to act on, e.g. `feature request`. */
  heldAs?: string;
}

const FREE: BoardCardOwner = { kind: 'free' };

/**
 * One pass over the card's inputs, freshest intent first: your own in-flight
 * click outranks a refused move, which outranks what the server is doing on its
 * own, which outranks a person's pending call. A live or parked session holds
 * the card over any queued effect.
 */
export function boardCardState(input: BoardCardStateInput): BoardCardState {
  const { decision, sessionStatus, transitionReason } = input;
  const request = yourRequest(input);
  if (request !== undefined) {
    return {
      status: { kind: 'busy', label: request.statusLabel },
      owner: { kind: 'you', progressLabel: request.progressLabel },
      wick: sessionStatus,
    };
  }
  const automation = decision === undefined ? undefined : automationOnCard(decision, sessionStatus);
  const refusedMove: BoardCardStatus | undefined =
    transitionReason === undefined ? undefined : { kind: 'error', label: transitionReason };
  const sessionOwner: BoardCardOwner | undefined =
    sessionStatus === undefined ? undefined : { kind: 'session', status: sessionStatus };
  return {
    status: refusedMove ?? automation?.status ?? statusWhenNothingInFlight(input),
    owner: sessionOwner ?? automation?.owner ?? FREE,
    wick: sessionStatus,
  };
}

/** @deprecated English only; use `busyCardMoveRefusal()`, which follows the UI language. */
export const BUSY_CARD_MOVE_REFUSAL = "Another run can't start while this card is busy.";

export function busyCardMoveRefusal(): string {
  return tk('cardState.busyMoveRefusal');
}

export function canStartRun(ownerKind: BoardCardOwner['kind']): boolean {
  return ownerKind === 'free';
}

export function canMoveTo(
  ownerKind: BoardCardOwner['kind'],
  phaseKind: InstalledPhaseInfo['kind'] | undefined,
): boolean {
  if (ownerKind === 'you') return false;
  return canStartRun(ownerKind) || !phaseMayStartRun(phaseKind);
}

function phaseMayStartRun(phaseKind: InstalledPhaseInfo['kind'] | undefined): boolean {
  return phaseKind !== 'resting' && phaseKind !== 'terminal';
}

function sessionIsLive(sessionStatus: SessionRowStatus | undefined): boolean {
  return sessionStatus === 'initializing' || sessionStatus === 'working';
}

function yourRequest(input: BoardCardStateInput): { statusLabel: string; progressLabel: string } | undefined {
  const { moving } = input;
  if (moving) {
    const statusLabel =
      moving.stage === 'done' ? tk('cardState.markingDone') : tk('cardState.movingTo', { stage: moving.label });
    return { statusLabel, progressLabel: tk('cardState.moving') };
  }
  if (input.preparing !== undefined) return { statusLabel: input.preparing, progressLabel: tk('cardState.starting') };
  if (input.retryRequested) return { statusLabel: tk('cardState.retrying'), progressLabel: tk('cardState.retrying') };
  return undefined;
}

function automationOnCard(
  decision: FactoryDecisionSummary,
  sessionStatus: SessionRowStatus | undefined,
): { status?: BoardCardStatus; owner: BoardCardOwner } {
  const copy = automationCopy(decision);
  const detail = decision.lastError ?? undefined;
  if (decision.status === 'failed') {
    return {
      status: {
        kind: 'error',
        label: copy.failed,
        ...(decision.canRetry ? { retryDecisionId: decision.id } : {}),
        detail,
      },
      owner: FREE,
    };
  }
  // The server retries a failure on its own, so it offers no button.
  if (retriesAfterFailure(decision)) {
    return {
      status: { kind: 'error', label: tk('cardState.failedRetrying', { failed: copy.failed }), detail },
      owner: { kind: 'automation', progressLabel: tk('cardState.retrying') },
    };
  }
  const owner: BoardCardOwner = { kind: 'automation', progressLabel: copy.progressLabel };
  if (runAnnouncedByWick(decision, sessionStatus)) return { owner };
  return { status: { kind: 'busy', label: copy.busy }, owner };
}

function statusWhenNothingInFlight(input: BoardCardStateInput): BoardCardStatus {
  if (sessionIsLive(input.sessionStatus)) return { kind: 'idle' };
  // A held card's live question is the maintainer's decision, even when a run
  // has been suggested for it: the card cannot start that run until it is accepted.
  if (input.heldAs !== undefined) {
    return { kind: 'held', label: tk('cardState.heldNeedsApproval', { kind: capitalize(input.heldAs) }) };
  }
  if (input.proposal) {
    return { kind: 'waiting', label: input.proposal.label, decisionId: input.proposal.decisionId };
  }
  return { kind: 'idle' };
}

/**
 * The sidebar's reading of a card's `waiting` and `error` kinds: a run parked
 * for approval, or an effect that failed for good. A retry the server still
 * owns is not a person's turn, and neither is a proposal that an effect in
 * flight already outranks on the card.
 */
export function itemAwaitsPerson(
  proposal: FactoryDecisionSummary | undefined,
  effect: FactoryDecisionSummary | undefined,
): boolean {
  if (effect) return effect.status === 'failed';
  return proposal !== undefined;
}

/** The system a linked card is synced with, named the way that system names the thing. */
function linkedSourceName(source: FactoryDecisionSummary['source']): string {
  switch (source) {
    case 'github-issue':
      return tk('linkedSource.githubIssue');
    case 'github-pr':
      return tk('linkedSource.githubPr');
    case 'gitlab-issue':
      return tk('linkedSource.gitlabIssue');
    case 'gitlab-pr':
      return tk('linkedSource.gitlabPr');
    case 'linear-issue':
      return tk('linkedSource.linearIssue');
    default:
      // Every linked-card decision carries its source; only a manual card would land here.
      return tk('linkedSource.card');
  }
}

function automationCopy(decision: Pick<FactoryDecisionSummary, 'type' | 'source'>): {
  busy: string;
  failed: string;
  progressLabel: string;
} {
  switch (decision.type) {
    case 'invokeSkill':
      return {
        busy: tk('automation.invokeSkill.busy'),
        failed: tk('automation.invokeSkill.failed'),
        progressLabel: tk('cardState.starting'),
      };
    case 'transition':
      return {
        busy: tk('automation.transition.busy'),
        failed: tk('automation.transition.failed'),
        progressLabel: tk('cardState.moving'),
      };
    case 'upsertLinkedWorkItem': {
      const source = linkedSourceName(decision.source);
      return {
        busy: tk('automation.sync.busy', { source }),
        failed: tk('automation.sync.failed', { source }),
        progressLabel: tk('automation.sync.progress'),
      };
    }
    case 'sendMessage':
    case 'notify':
      return {
        busy: tk('automation.notify.busy'),
        failed: tk('automation.notify.failed'),
        progressLabel: tk('automation.notify.progress'),
      };
    default:
      return {
        busy: tk('automation.other.busy'),
        failed: tk('automation.other.failed'),
        progressLabel: tk('automation.other.progress'),
      };
  }
}

/**
 * The lease outlives kickoff until the dispatcher sees the run end: shown as a row it would double
 * the wick for the whole run and linger on a card the agent already moved to Done.
 */
function runAnnouncedByWick(
  decision: Pick<FactoryDecisionSummary, 'type' | 'status'>,
  sessionStatus: SessionRowStatus | undefined,
): boolean {
  return decision.type === 'invokeSkill' && decision.status === 'leased' && sessionIsLive(sessionStatus);
}

/**
 * `retry` alone does not mean anything went wrong: a linked-card decision that
 * already succeeded is deliberately reset to `retry` when its card is
 * rematerialized, so the card gets re-filed. That replay has no attempt behind
 * it and no error, and calling it a failure makes the board cry wolf. A real
 * failure has been tried at least once, or left an error to show.
 */
function retriesAfterFailure(decision: Pick<FactoryDecisionSummary, 'status' | 'attempts' | 'lastError'>): boolean {
  return decision.status === 'retry' && (decision.attempts > 0 || Boolean(decision.lastError));
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
