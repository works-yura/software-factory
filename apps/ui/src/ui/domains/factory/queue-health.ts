/**
 * Client-side aggregation for the Analytics page's queue-health chart.
 *
 * Pure, DB-free functions over `work_items` rows — mirrors the discipline of
 * the server-side `computeFactoryMetrics`, but runs in the UI because the chart
 * ages every card against "now" on each poll. This module takes all inputs and
 * returns a plain shape, so it is unit-testable without a network or DOM.
 */

import type { QueueHealthConfig } from '@factory/store/queue-health/base';

import type { StageLane } from '../analytics/stages';
import { laneKey } from '../analytics/stages';
import type { WorkItem, WorkItemStageEntry } from './services/workItems';

/**
 * The row shape the aggregation reads. The client list endpoint serializes
 * `createdAt` to an ISO string, but accepting a `Date` too keeps the function
 * usable from server-shaped rows without a mapping layer.
 */
export type QueueHealthWorkItem = Pick<WorkItem, 'id' | 'title' | 'url' | 'board' | 'stages' | 'stageHistory' | 'sessions'> & {
  createdAt: Date | string;
};

/** Age-bucket keys, in left→right segment order. */
export const AGE_BUCKETS = ['green', 'amber', 'orange', 'red'] as const;
export type AgeBucket = (typeof AGE_BUCKETS)[number];

/** One drill-down row: a work item's presence in one stage. */
export interface QueueHealthEntry {
  itemId: string;
  title: string;
  url: string | null;
  /** The board the card sits on, for a link to it. */
  board: string;
  /** Lane key (`<board>/<phase>`). */
  key: string;
  /** The phase id. */
  stage: string;
  stageLabel: string;
  ageSeconds: number;
  bucket: AgeBucket;
  active: boolean;
}

/** One bar in the chart: a working stage segmented by age bucket. */
export interface QueueHealthStage {
  /** Lane key (`<board>/<phase>`): unique across boards. */
  key: string;
  /** The phase id. */
  stage: string;
  label: string;
  total: number;
  buckets: Record<AgeBucket, number>;
  /** Entries in this stage whose item has ≥1 active session. */
  activeCount: number;
}

export interface QueueHealth {
  stages: QueueHealthStage[];
  /** Flat per-(item, stage) index so the drill-down list needs no second fetch. */
  entries: QueueHealthEntry[];
}

function parseTime(iso: string): number {
  const time = Date.parse(iso);
  return Number.isNaN(time) ? 0 : time;
}

/** Open (no `exitedAt`) history entries for currently-held stages. */
function openEntries(item: QueueHealthWorkItem): WorkItemStageEntry[] {
  return item.stageHistory.filter(entry => entry.exitedAt === undefined && item.stages.includes(entry.stage));
}

/** The bucket an age falls into: `ageSeconds >= boundary` moves to the higher bucket. */
function bucketFor(ageSeconds: number, thresholdsSeconds: number[]): AgeBucket {
  let index = 0;
  for (const boundary of thresholdsSeconds) {
    if (ageSeconds >= boundary) index += 1;
  }
  return AGE_BUCKETS[Math.min(index, AGE_BUCKETS.length - 1)]!;
}

/**
 * The open entry for the item's *current* visit to `stage`. Re-entering a
 * stage (execute → review → execute) appends a new open entry without closing
 * the earlier one, so multiple open entries can coexist for one stage; the
 * current visit is the latest, so scan from the end.
 */
function latestOpenEntryFor(open: WorkItemStageEntry[], stage: string): WorkItemStageEntry | undefined {
  for (let i = open.length - 1; i >= 0; i--) {
    if (open[i]!.stage === stage) return open[i]!;
  }
  return undefined;
}

/** Cards the Factory ran: starting a run records its session on the row. */
function hasFactoryRun(item: QueueHealthWorkItem): boolean {
  return Object.keys(item.sessions).length > 0;
}

/**
 * Aggregate work items into per-stage age buckets plus an active-work count.
 *
 * Aging is per-(item, stage): an item holding N open stages contributes one
 * entry to each, aged from that stage's own `enteredAt` — so a stage's bar
 * reflects the age of work *currently in that stage* (totals across bars may
 * exceed the unique-item count). A held stage with no open history entry
 * falls back to the item's `createdAt`.
 *
 * Only the working stages the boards declare (`lanes`) are charted: resting
 * stages mix in work nobody has picked up yet, and terminal stages are done.
 *
 * Only cards the Factory ran are charted — the population the in-flight count
 * reports, and the same rule `@factory/api/metrics` applies server-side. The
 * integrations sync every issue and PR of a connected repo into the lanes, and
 * those cards age forever without anyone working them, so charting them pins
 * the queue red on the upstream backlog rather than on work that is actually stuck.
 */
export function computeQueueHealth(
  items: readonly QueueHealthWorkItem[],
  activeSessions: ReadonlySet<string>,
  config: QueueHealthConfig,
  lanes: readonly StageLane[],
  now: Date = new Date(),
): QueueHealth {
  const nowMs = now.getTime();
  const thresholds = config.thresholdsSeconds;

  const byStage = new Map<string, QueueHealthStage>();
  for (const lane of lanes) {
    byStage.set(lane.key, {
      key: lane.key,
      stage: lane.stage,
      label: lane.label,
      total: 0,
      buckets: { green: 0, amber: 0, orange: 0, red: 0 },
      activeCount: 0,
    });
  }

  const entries: QueueHealthEntry[] = [];

  for (const item of items) {
    if (!hasFactoryRun(item)) continue;

    const open = openEntries(item);
    const active = Object.values(item.sessions).some(ref => activeSessions.has(ref.sessionId));

    for (const stage of item.stages) {
      const key = laneKey(item.board, stage);
      const stageAgg = byStage.get(key);
      if (!stageAgg) continue; // not a working stage of an installed board — not charted

      const entry = latestOpenEntryFor(open, stage);
      // Fall back to creation time when history has no open entry for the held
      // stage (shouldn't happen since history is server-appended).
      const enteredAt =
        entry?.enteredAt ?? (item.createdAt instanceof Date ? item.createdAt.toISOString() : item.createdAt);
      const ageSeconds = Math.max(0, Math.round((nowMs - parseTime(enteredAt)) / 1000));
      const bucket = bucketFor(ageSeconds, thresholds);

      stageAgg.total += 1;
      stageAgg.buckets[bucket] += 1;
      if (active) stageAgg.activeCount += 1;

      entries.push({
        itemId: item.id,
        title: item.title,
        url: item.url,
        board: key.slice(0, key.length - stage.length - 1),
        key,
        stage,
        stageLabel: stageAgg.label,
        ageSeconds,
        bucket,
        active,
      });
    }
  }

  return { stages: [...byStage.values()], entries };
}
