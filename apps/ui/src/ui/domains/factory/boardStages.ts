import type { FactoryRuleBoard, FactoryRuleStage } from '@factory/core/rules/types';

import { isPullRequestSource } from './services/workItems';
import type { WorkItem, WorkItemSource } from './services/workItems';
import { BOARD_STAGES, stageLabel, stageOrder } from './stages';
import type { BoardStage, BoardStageId } from './stages';

export type BoardKind = FactoryRuleBoard;

/** A pull request's card on Work moves only through the lanes that review it; Review is the builder's self-review. */
const PULL_REQUEST_LANES: ReadonlySet<FactoryRuleStage> = new Set(['intake', 'pr-review', 'done', 'canceled']);
const PULL_REQUEST_STAGES: ReadonlyArray<BoardStage> = BOARD_STAGES.filter(stage => PULL_REQUEST_LANES.has(stage.id));
/** Every other card on Work moves through every lane but PR review. */
const WORK_ITEM_STAGES: ReadonlyArray<BoardStage> = BOARD_STAGES.filter(stage => stage.id !== 'pr-review');

export function belongsToBoard(item: WorkItem, kind: BoardKind): boolean {
  return itemBoard(item) === kind;
}

export function itemAppearsInStage(
  item: WorkItem,
  stage: BoardStageId,
  stages: ReadonlyArray<{ id: BoardStageId }>,
): boolean {
  if (item.stages.includes(stage)) return true;
  return stage === 'intake' && !stages.some(candidate => item.stages.includes(candidate.id));
}

export function boardLoadingStages({
  stages,
  itemsPending,
  intakePending,
  triagePending,
}: {
  stages: ReadonlyArray<BoardStage>;
  itemsPending: boolean;
  intakePending: boolean;
  triagePending: boolean;
}): ReadonlySet<BoardStageId> {
  const loading = new Set<BoardStageId>();
  if (itemsPending) {
    for (const stage of stages) loading.add(stage.id);
  }
  if (intakePending) loading.add('intake');
  if (triagePending) loading.add('triage');
  return loading;
}

/** Cards filed before boards were recorded belong to Work, pull request cards included. */
export function itemBoard(item: WorkItem): string {
  return item.board ?? 'work';
}

export function itemStageOptions(item: WorkItem): ReadonlyArray<BoardStage> {
  const board = itemBoard(item);
  if (board === 'work') return isPullRequestSource(item.source) ? PULL_REQUEST_STAGES : WORK_ITEM_STAGES;
  return BOARD_STAGES;
}

/** Whether a card from `source` on `board` may enter `stage`: on Work, PR review is a pull request's own lane. */
export function pullRequestMayEnter(board: string, source: WorkItemSource, stage: string): boolean {
  if (board !== 'work') return true;
  if (!isPullRequestSource(source)) return stage !== 'pr-review';
  return PULL_REQUEST_STAGES.some(lane => lane.id === stage);
}

export function itemStageLabel(item: WorkItem, stage: string): string {
  return itemStageOptions(item).find(candidate => candidate.id === stage)?.label ?? stageLabel(stage);
}

/** Furthest stage the item currently sits in; items with no known stage read as Intake, like the board columns. */
export function currentItemStageLabel(item: WorkItem): string {
  const options = itemStageOptions(item);
  // Stages off this item's board sort after every column, so keeping them would beat the real one
  const onBoard = item.stages.filter(stage => options.some(candidate => candidate.id === stage));
  const furthest = onBoard.sort((a, b) => stageOrder(b) - stageOrder(a)).at(0);
  return itemStageLabel(item, furthest ?? 'intake');
}
