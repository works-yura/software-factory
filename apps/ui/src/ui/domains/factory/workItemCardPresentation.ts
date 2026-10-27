import type { InstalledBoardInfo } from '../../../api/types';
import { itemStageLabel } from './boardStages';
import type { CardMove } from './cardPrimaryAction';
import type { FactoryDecisionSummary } from './services/decisions';
import type { WorkItem } from './services/workItems';
import { phaseTitle } from '../../i18n/boardLabels';
import { translator } from '../../i18n/t';

const tk = translator('board');

// The lane's own move first: clicking the button of the column a card sits in re-runs that lane.
// Then the first lane whose seat is still free, so a card never leads with a run it has already had.
export function primaryCardMove(moves: CardMove[], columnStage: string, sessions: WorkItem['sessions']) {
  const columnMove = moves.find(move => move.stage === columnStage);
  if (columnMove) return columnMove;
  const unusedMove = moves.find(move => !(move.role in sessions));
  return unusedMove ?? moves[0];
}

export function nextBoardPhase(definition: InstalledBoardInfo | undefined, columnStage: string) {
  const currentPhase = definition?.phases.find(phase => phase.id === columnStage);
  const nextPhaseId = currentPhase?.transitions?.[0]?.to;
  const nextPhase = definition?.phases.find(phase => phase.id === nextPhaseId);
  if (!nextPhase) return undefined;
  return { id: nextPhase.id, label: nextPhase.title };
}

export function proposedCardRun(
  proposal: FactoryDecisionSummary | undefined,
  custom: boolean,
  definition: InstalledBoardInfo | undefined,
  moves: CardMove[],
  primaryMove: CardMove | undefined,
) {
  if (!proposal) return undefined;
  if (custom) {
    const phase = definition?.phases.find(phase => phase.role === proposal.role);
    // A proposal for a role this board never declares is a leftover from another board.
    if (!phase) return undefined;
    return { decisionId: proposal.id, label: phaseTitle(definition!.id, phase.id, phase.title), action: undefined };
  }
  const proposedMove = moves.find(move => move.role === proposal.role);
  const move = proposedMove ?? primaryMove;
  return { decisionId: proposal.id, label: move?.label ?? tk('menu.startRun'), action: move?.action };
}

export function movingCardStatus(
  stage: string | undefined,
  definition: InstalledBoardInfo | undefined,
  item: WorkItem,
) {
  if (stage === undefined) return undefined;
  const phase = definition?.phases.find(phase => phase.id === stage);
  return { stage, label: phase && definition ? phaseTitle(definition.id, phase.id, phase.title) : itemStageLabel(item, stage) };
}
