import { DEFAULT_BOARD_ID } from '@factory/core/boards/default-board';

import type { InstalledBoardInfo } from '../../../api/types';
import { boardTitle, phaseTitle } from '../../i18n/boardLabels';
import { orderedBoards } from '../factory/boardCatalog';

/**
 * Board stages as the Analytics widgets read them. Upstream had one fixed board (`stages.ts`:
 * `PIPELINE_STAGES`, `stageLabel`, `stageOrder`); here every installed board brings its own phases,
 * so the order and names come from the board catalog. A pipeline stage is a working phase: resting
 * and terminal phases have no pass to hand over and no queue to age.
 */
type Board = Pick<InstalledBoardInfo, 'id' | 'title' | 'name' | 'phases'>;

/** One working phase of one board: a row of the queue-health chart. */
export interface StageLane {
  /** `<board>/<phase>`: two boards may both name a phase `review`. */
  key: string;
  board: string;
  stage: string;
  label: string;
}

const phaseName = (board: Board, phase: Board['phases'][number]) =>
  phaseTitle(board.id, phase.id, phase.name ?? phase.title);

export function laneKey(board: string | null | undefined, stage: string): string {
  return `${board ?? DEFAULT_BOARD_ID}/${stage}`;
}

/** Every working phase in board order, then phase order; the board's name joins the label once there are several. */
export function pipelineLanes(boards: readonly Board[]): StageLane[] {
  const withLanes = orderedBoards(boards).filter(board => board.phases.some(phase => phase.kind === 'working'));
  const named = withLanes.length > 1;
  return withLanes.flatMap(board =>
    board.phases
      .filter(phase => phase.kind === 'working')
      .map(phase => ({
        key: laneKey(board.id, phase.id),
        board: board.id,
        stage: phase.id,
        label: named
          ? `${boardTitle(board.id, board.name ?? board.title)} · ${phaseName(board, phase)}`
          : phaseName(board, phase),
      })),
  );
}

/**
 * Names and order for stage ids that carry no board (the server's per-stage rows): the first board
 * holding the phase names it, and the column order across boards orders it. A stage no board
 * holds keeps its id and sorts last.
 */
export interface StageCatalog {
  label(stage: string): string;
  order(stage: string): number;
  /** Working phase ids across every board, in column order, each once. */
  pipelineStages: string[];
}

export function stageCatalog(boards: readonly Board[]): StageCatalog {
  const labels = new Map<string, string>();
  const order = new Map<string, number>();
  const pipeline: string[] = [];
  for (const board of orderedBoards(boards)) {
    for (const phase of board.phases) {
      if (!labels.has(phase.id)) labels.set(phase.id, phaseName(board, phase));
      if (!order.has(phase.id)) order.set(phase.id, order.size);
      if (phase.kind === 'working' && !pipeline.includes(phase.id)) pipeline.push(phase.id);
    }
  }
  return {
    label: stage => labels.get(stage) ?? stage,
    order: stage => order.get(stage) ?? Number.MAX_SAFE_INTEGER,
    pipelineStages: pipeline,
  };
}
