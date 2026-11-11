import { boardForWorkItem, needsApproval } from '@factory/core';
import type { WorkItemRow } from '@factory/store';

/** Work phases past Triage: a card that reached one was moved on by a person, which is the approval. */
const PAST_TRIAGE = new Set(['planning', 'execute', 'review']);

/**
 * When a person first moved the card past Intake and Triage. Factory no longer stamps
 * `acceptedAt` (upstream #29039); a card that predates that keeps its stamp.
 */
export function acceptedAtOf(item: Pick<WorkItemRow, 'acceptedAt' | 'stageHistory'>): Date | null {
  if (item.acceptedAt) return item.acceptedAt;
  const entry = item.stageHistory.find(candidate => PAST_TRIAGE.has(candidate.stage));
  return entry ? new Date(entry.enteredAt) : null;
}

/**
 * Triage left the Work card in Intake for a person (or its source asks for approval), and it has
 * not been past Triage since; the board shows the same held state.
 */
export function heldForPerson(
  item: Pick<WorkItemRow, 'board' | 'externalSource' | 'stages' | 'sessions' | 'stageHistory' | 'metadata'>,
): boolean {
  if (boardForWorkItem(item) !== 'work' || item.stages[0] !== 'intake') return false;
  if (needsApproval(item, stage => stage === 'intake' || stage === 'triage')) return true;
  return item.sessions.triage !== undefined && !item.stageHistory.some(entry => PAST_TRIAGE.has(entry.stage));
}
