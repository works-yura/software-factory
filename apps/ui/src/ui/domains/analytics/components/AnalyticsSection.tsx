import { DEFAULT_BOARD_ID } from '@factory/core/boards/default-board';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { SegmentedControl, SegmentedControlItem } from '@mastra/playground-ui/components/SegmentedControl';
import { Skeleton } from '@mastra/playground-ui/components/Skeleton';
import { Txt } from '@mastra/playground-ui/components/Txt';
import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';

import { useBoardCatalog } from '../../../../hooks/useBoardCatalog';
import { useFactoryMetrics } from '../../../../hooks/useFactoryMetrics';
import { useUsageSummaryQuery } from '../../../../hooks/useUsage';
import { useRunningSessions, useWorkItemsQuery } from '../../../../hooks/useWorkItems';
import { AnalyticsEmptyState } from './AnalyticsEmptyState';
import type { KpiExpansion, KpiId } from './AnalyticsKpis';
import { UsageKpis, WorkKpis } from './AnalyticsKpis';
import { LimitsOverview } from './LimitsOverview';
import { RangePicker } from './RangePicker';
import { UsageBreakdowns } from './UsageBreakdowns';
import { WorkBreakdowns } from './WorkBreakdowns';
import type { RangePreset } from '../ranges';
import { DEFAULT_RANGE_DAYS, isRangePreset, rangeWindow } from '../ranges';
import { stageCatalog } from '../stages';
import { rememberedBoardPath } from '../../factory/services/boardViews';
import type { FactoryMetrics } from '../../factory/services/metrics';
import { useActiveFactory } from '../../workspaces/components/FactoryLayout';
import { translator } from '../../../i18n/t';

const tk = translator('analytics');
const tu = translator('usage');

type Scope = 'factory' | 'all';

/** The window and the Factories counted live in the URL, so a view can be linked and survives a reload. */
function useAnalyticsParams() {
  const [params, setParams] = useSearchParams();
  const range = params.get('range');
  const rangeDays: RangePreset = isRangePreset(range) ? (Number(range) as RangePreset) : DEFAULT_RANGE_DAYS;
  const scope: Scope = params.get('scope') === 'all' ? 'all' : 'factory';
  const update = (name: string, value: string | null) =>
    setParams(
      previous => {
        const next = new URLSearchParams(previous);
        if (value === null) next.delete(name);
        else next.set(name, value);
        return next;
      },
      { replace: true },
    );
  return {
    rangeDays,
    scope,
    setRangeDays: (days: RangePreset) => update('range', days === DEFAULT_RANGE_DAYS ? null : String(days)),
    setScope: (next: Scope) => update('scope', next === 'all' ? 'all' : null),
  };
}

/** The window and the Factories counted, as the settings header's actions. */
export function AnalyticsControls() {
  const { rangeDays, scope, setRangeDays, setScope } = useAnalyticsParams();
  return (
    <>
      <SegmentedControl aria-label={tk('scope.label')} size="sm" value={scope} onValueChange={setScope}>
        <SegmentedControlItem value="factory">{tk('scope.factory')}</SegmentedControlItem>
        <SegmentedControlItem value="all">{tk('scope.all')}</SegmentedControlItem>
      </SegmentedControl>
      <RangePicker rangeDays={rangeDays} onSelect={setRangeDays} />
    </>
  );
}

/**
 * Settings › Analytics: how the Factory's work flowed and what its agents spent doing it, over one
 * preset window. Upstream's Metrics page (a row of KPI cards whose trend grows into its daily chart,
 * then tabbed breakdowns), with the usage the Factory records read the same way.
 */
export function AnalyticsSection() {
  const factory = useActiveFactory();
  const { rangeDays, scope, setRangeDays } = useAnalyticsParams();
  return (
    <AnalyticsContent
      key={factory.id}
      factoryProjectId={factory.id}
      rangeDays={rangeDays}
      scope={scope}
      onWiden={rangeDays < 365 ? () => setRangeDays(365) : undefined}
    />
  );
}

function AnalyticsContent({
  factoryProjectId,
  rangeDays,
  scope,
  onWiden,
}: {
  factoryProjectId: string;
  rangeDays: RangePreset;
  scope: Scope;
  onWiden?: () => void;
}) {
  // Fixed for the page's life, so a window crossing midnight does not refetch under the reader.
  const [now] = useState(() => new Date());
  const range = useMemo(() => rangeWindow(rangeDays, now), [rangeDays, now]);
  const metricsQuery = useFactoryMetrics(factoryProjectId, range);
  const usageQuery = useUsageSummaryQuery({ ...range, ...(scope === 'factory' ? { factoryProjectId } : {}) });
  const itemsQuery = useWorkItemsQuery(factoryProjectId);
  const catalog = useBoardCatalog(factoryProjectId);
  const agentsRunning = useRunningSessions(factoryProjectId).size;
  const [expanded, setExpanded] = useState<KpiId | null>(null);
  const expansion: KpiExpansion = { expanded, onExpandedChange: setExpanded };
  const stages = useMemo(() => stageCatalog(catalog.data ?? []), [catalog.data]);

  const metrics = metricsQuery.data;
  const summary = usageQuery.data;
  const boardLink = rememberedBoardPath(factoryProjectId, DEFAULT_BOARD_ID);
  const quiet = metrics !== undefined && summary !== undefined && !hasWork(metrics) && summary.total.turns === 0;
  const hasHistory = (itemsQuery.data ?? []).some(item => Object.keys(item.sessions).length > 0);

  return (
    <div className="flex flex-col gap-12">
      {quiet ? (
        <AnalyticsEmptyState hasHistory={hasHistory} rangeDays={rangeDays} boardPath={boardLink} onWiden={onWiden} />
      ) : null}

      <Section title={tk('sections.work')} note={scope === 'all' ? tk('scope.workNote') : undefined}>
        {metricsQuery.isError ? (
          <Notice variant="destructive">
            {tk('error', { message: metricsQuery.error instanceof Error ? metricsQuery.error.message : '' })}
          </Notice>
        ) : metrics ? (
          <>
            <WorkKpis metrics={metrics} agentsRunning={agentsRunning} expansion={expansion} />
            <WorkBreakdowns factoryProjectId={factoryProjectId} metrics={metrics} stages={stages} />
          </>
        ) : (
          <KpiLoading />
        )}
      </Section>

      <Section title={tk('sections.usage')}>
        {usageQuery.isError ? (
          <Notice variant="destructive">{tu('page.error')}</Notice>
        ) : summary ? (
          <>
            <UsageKpis summary={summary} expansion={expansion} />
            <Txt as="p" variant="meta" tone="muted" className="-mt-4 m-0">
              {tu('cost.note')}
              {summary.total.unpricedTurns > 0 ? ` ${tu('cost.partlyUnpriced', { count: summary.total.unpricedTurns })}` : ''}
            </Txt>
            <UsageBreakdowns summary={summary} allFactories={scope === 'all'} />
          </>
        ) : (
          <KpiLoading />
        )}
      </Section>

      <Section title={tk('sections.limits')} note={tk('limits.note')}>
        <LimitsOverview />
      </Section>
    </div>
  );
}

/** Anything the work metrics would draw in this window. */
function hasWork(metrics: FactoryMetrics): boolean {
  return (
    metrics.wipTotal > 0 ||
    metrics.sourceMix.length > 0 ||
    metrics.agentCoverage.length > 0 ||
    metrics.throughput.some(point => point.count > 0)
  );
}

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-8">
      <div className="flex flex-col gap-1">
        <Txt as="h2" variant="heading" tone="ink" className="m-0">
          {title}
        </Txt>
        {note ? (
          <Txt as="p" variant="meta" tone="muted" className="m-0">
            {note}
          </Txt>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function KpiLoading() {
  return (
    <div role="status" aria-label={tk('loading')} className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Skeleton className="h-28 w-full rounded-xl sm:col-span-2" />
      <Skeleton className="h-28 w-full rounded-xl" />
      <Skeleton className="h-28 w-full rounded-xl" />
    </div>
  );
}
