import { Badge } from '@mastra/playground-ui/components/Badge';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { Popover, PopoverContent } from '@mastra/playground-ui/components/Popover';
import { Skeleton } from '@mastra/playground-ui/components/Skeleton';
import { Txt } from '@mastra/playground-ui/components/Txt';
import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';

import { useBoardCatalog } from '../../../../hooks/useBoardCatalog';
import { useQueueHealthThresholds } from '../../../../hooks/useQueueHealthThresholds';
import { useRunningSessions, useWorkItemsQuery } from '../../../../hooks/useWorkItems';
import { translator } from '../../../i18n/t';
import { pipelineLanes } from '../../analytics/stages';
import { boardPath } from '../boardCatalog';
import type { QueueHealth, QueueHealthEntry } from '../queue-health';
import { computeQueueHealth } from '../queue-health';
import type { QueueHealthSelection } from './QueueHealthChart';
import { bucketLabel, formatAgeSeconds, QueueHealthChart } from './QueueHealthChart';

const tk = translator('analytics');

const DEFAULT_THRESHOLDS = [14400, 86400, 259200];

/** An open drill-down is a cohort plus the cell it hangs off. */
interface DrillDown {
  selection: QueueHealthSelection;
  anchor: HTMLElement;
}

export function QueueHealthPanel({
  factoryProjectId,
  emptyAction,
}: {
  factoryProjectId: string | undefined;
  emptyAction?: ReactNode;
}) {
  const workItemsQuery = useWorkItemsQuery(factoryProjectId);
  const thresholdsQuery = useQueueHealthThresholds(factoryProjectId);
  const catalog = useBoardCatalog(factoryProjectId);
  const activeSessions = useRunningSessions(factoryProjectId);
  const [drillDown, setDrillDown] = useState<DrillDown | null>(null);

  const health = useMemo(() => {
    const items = workItemsQuery.data ?? [];
    const config = thresholdsQuery.data ?? { thresholdsSeconds: DEFAULT_THRESHOLDS };
    return computeQueueHealth(items, activeSessions, config, pipelineLanes(catalog.data ?? []), new Date());
  }, [workItemsQuery.data, activeSessions, thresholdsQuery.data, catalog.data]);

  if (workItemsQuery.isError) {
    return <Notice variant="destructive">{(workItemsQuery.error as Error).message}</Notice>;
  }
  if (thresholdsQuery.isError) {
    return <Notice variant="destructive">{(thresholdsQuery.error as Error).message}</Notice>;
  }

  if (!workItemsQuery.data || !thresholdsQuery.data || !catalog.data) {
    return (
      <div role="status" aria-label={tk('queue.loading')} className="flex flex-col gap-5">
        <Skeleton className="h-10 w-full rounded-lg" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  const thresholds = thresholdsQuery.data.thresholdsSeconds;
  const entries = drillDown ? cohortEntries(health, drillDown.selection) : [];
  // Work items refetch on a timer: a cohort emptying unmounts the cell the
  // popover hangs off, leaving the anchor detached.
  if (drillDown && entries.length === 0) setDrillDown(null);
  const cohort = drillDown?.selection ?? null;

  return (
    <>
      <QueueHealthChart
        health={health}
        thresholdsSeconds={thresholds}
        selected={cohort}
        onSelect={(selection, anchor) => setDrillDown(selection && anchor ? { selection, anchor } : null)}
        emptyAction={emptyAction}
      />
      <Popover
        open={drillDown !== null}
        onOpenChange={open => {
          if (!open) setDrillDown(null);
        }}
      >
        {drillDown ? (
          <PopoverContent
            anchor={drillDown.anchor}
            side="bottom"
            aria-label={tk('queue.cohortTasks', { cohort: cohortLabel(health, drillDown.selection) })}
            className="w-80 p-0"
          >
            <CohortTasks health={health} selection={drillDown.selection} entries={entries} />
          </PopoverContent>
        ) : null}
      </Popover>
    </>
  );
}

function cohortLabel(health: QueueHealth, selection: QueueHealthSelection): string {
  if (selection.stage === null) return bucketLabel(selection.bucket);
  const stage = health.stages.find(candidate => candidate.key === selection.stage);
  return `${stage?.label ?? selection.stage} · ${bucketLabel(selection.bucket)}`;
}

function cohortEntries(health: QueueHealth, selection: QueueHealthSelection): QueueHealthEntry[] {
  return health.entries
    .filter(entry => entry.bucket === selection.bucket && (selection.stage === null || entry.key === selection.stage))
    .sort((a, b) => b.ageSeconds - a.ageSeconds);
}

function CohortTasks({
  health,
  selection,
  entries,
}: {
  health: QueueHealth;
  selection: QueueHealthSelection;
  entries: QueueHealthEntry[];
}) {
  const { factoryId } = useParams<{ factoryId: string }>();
  return (
    <div className="flex max-h-80 flex-col">
      <Txt as="p" variant="label" tone="ink" className="m-0 px-3 pt-3 pb-1">
        {cohortLabel(health, selection)}
        <Txt as="span" variant="meta" tone="muted" className="ml-2">
          {tk('queue.tasks', { count: entries.length })}
        </Txt>
      </Txt>

      <ul className="m-0 flex list-none flex-col overflow-y-auto p-1 pt-0">
        {entries.map(entry => (
          <li
            key={`${entry.itemId}:${entry.key}`}
            // rule sits in the 1px gap below the row — rounded hover bg never meets it
            className="relative mb-px flex min-w-0 cursor-pointer items-center gap-3 rounded-md px-2 py-2 transition-colors after:absolute after:inset-x-2 after:-bottom-px after:h-px after:bg-border last:mb-0 last:after:hidden hover:bg-fill-subtle has-[a:focus-visible]:outline-1 has-[a:focus-visible]:outline-border-focus"
          >
            <span className="min-w-0 flex-1">
              {factoryId ? (
                // stretched link — the whole row is the hit area
                <Link
                  to={`${boardPath(factoryId, entry.board)}?item=${encodeURIComponent(entry.itemId)}`}
                  className="block truncate text-body-sm text-foreground no-underline after:absolute after:inset-0 hover:underline focus-visible:outline-none"
                >
                  {entry.title}
                </Link>
              ) : (
                <span className="block truncate text-body-sm text-foreground">{entry.title}</span>
              )}
              <Txt as="span" variant="meta" tone="muted" className="mt-0.5 block">
                {tk('queue.inStage', { age: formatAgeSeconds(entry.ageSeconds) })}
              </Txt>
            </span>
            {entry.active ? (
              <span
                role="img"
                aria-label={tk('queue.agentRunning')}
                className="inline-flex size-1.5 shrink-0 rounded-full bg-brand-green"
              />
            ) : null}
            {selection.stage === null ? <Badge size="xs">{entry.stageLabel}</Badge> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
