import { MetricsLineChart } from '@mastra/playground-ui/components/MetricsLineChart';
import type { MetricsLineChartSeries } from '@mastra/playground-ui/components/MetricsLineChart';
import { MetricsStackedBarChart } from '@mastra/playground-ui/components/MetricsStackedBarChart';
import { MetricsReadout, MetricsTrendCard } from '@mastra/playground-ui/components/MetricsTrendCard';
import { CircleCheck, Coins, Clock3, DatabaseZap, Layers3, MessageSquareText, Sigma } from 'lucide-react';

import type { UsageSummaryResponse } from '../../../../api/types';
import { formatDuration } from '../../../../lib/date';
import { translator } from '../../../i18n/t';
import type { FactoryMetrics } from '../../factory/services/metrics';
import { formatTokens, formatUsd } from '../../usage/format';
import { dayLabel, formatPerDay } from '../ranges';

const tk = translator('analytics');
const tu = translator('usage');

export type KpiId = 'completed' | 'tokens' | 'cost' | 'turns' | 'cacheShare';

export interface KpiExpansion {
  expanded: KpiId | null;
  onExpandedChange: (id: KpiId | null) => void;
}

const GRID = 'm-0 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4';
const CHART_HEIGHT = 260;

function toggle(id: KpiId, { expanded, onExpandedChange }: KpiExpansion) {
  return {
    expanded: expanded === id,
    onExpandedChange: (open: boolean) => onExpandedChange(open ? id : null),
  };
}

function action(open: boolean): string {
  return open ? tk('kpi.hide') : tk('kpi.show');
}

/** Work: completions with their daily chart, lead time, and what is in flight now. */
export function WorkKpis({
  metrics,
  agentsRunning,
  expansion,
}: {
  metrics: FactoryMetrics;
  agentsRunning: number;
  expansion: KpiExpansion;
}) {
  const completed = metrics.throughput.reduce((sum, point) => sum + point.count, 0);
  const { daysCovered } = metrics;
  const perDay = tk('kpi.perDay', { value: formatPerDay(daysCovered === 0 ? 0 : completed / daysCovered) });
  const open = expansion.expanded === 'completed';
  const series: MetricsLineChartSeries[] = [
    { dataKey: 'done', label: tk('kpi.completedSeries'), color: 'var(--chart-green)' },
  ];

  return (
    <dl aria-label={tk('sections.work')} className={GRID}>
      <MetricsTrendCard
        {...toggle('completed', expansion)}
        icon={<CircleCheck aria-hidden="true" className="text-success-indicator" />}
        label={tk('kpi.completed')}
        value={String(completed)}
        detail={perDay}
        values={metrics.throughput.map(point => point.count)}
        color="var(--chart-green)"
        empty={completed === 0}
        toggleLabel={tk('kpi.completedToggle', { count: completed, perDay, action: action(open) })}
        chartCaption={tk('kpi.completedChart', { count: daysCovered })}
        className="sm:col-span-2"
      >
        <MetricsLineChart
          data={metrics.throughput.map(point => ({ time: dayLabel(point.date), done: point.count }))}
          series={series}
          height={CHART_HEIGHT}
        />
      </MetricsTrendCard>
      <MetricsReadout
        icon={<Clock3 aria-hidden="true" />}
        label={tk('kpi.leadTime')}
        value={formatDuration(metrics.leadTime.medianMs)}
        detail={
          metrics.leadTime.p90Ms === null
            ? tk('kpi.leadTimeSamples', { count: metrics.leadTime.samples })
            : tk('kpi.leadTimeDetail', { p90: formatDuration(metrics.leadTime.p90Ms), count: metrics.leadTime.samples })
        }
      />
      <MetricsReadout
        icon={<Layers3 aria-hidden="true" />}
        label={tk('kpi.inFlight')}
        value={String(metrics.wipTotal)}
        detail={tk('kpi.inFlightDetail', { count: agentsRunning })}
      />
    </dl>
  );
}

function cacheShareOf(totals: UsageSummaryResponse['total']['totals']): number | null {
  const input = totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens;
  return input > 0 ? Math.round((totals.cacheReadTokens / input) * 100) : null;
}

/** Usage: tokens, what they would cost, turns and the share of input read from cache, each per day. */
export function UsageKpis({ summary, expansion }: { summary: UsageSummaryResponse; expansion: KpiExpansion }) {
  const { total, byDay } = summary;
  const days = Math.max(byDay.length, 1);
  const empty = total.turns === 0;
  const cacheShare = cacheShareOf(total.totals);
  const rows = byDay.map(day => ({
    time: dayLabel(day.day),
    input: day.totals.inputTokens,
    cacheRead: day.totals.cacheReadTokens,
    cacheWrite: day.totals.cacheWriteTokens,
    output: day.totals.outputTokens,
    cost: day.costUsd,
    turns: day.turns,
    cacheShare: cacheShareOf(day.totals) ?? 0,
  }));
  const tokenSeries: MetricsLineChartSeries[] = [
    { dataKey: 'input', label: tu('category.input'), color: 'var(--chart-share-1)' },
    { dataKey: 'cacheRead', label: tu('category.cacheRead'), color: 'var(--chart-share-3)' },
    { dataKey: 'cacheWrite', label: tu('category.cacheWrite'), color: 'var(--chart-share-4)' },
    { dataKey: 'output', label: tu('category.output'), color: 'var(--chart-share-2)' },
  ];
  const card = (id: KpiId, label: string, value: string) => ({
    ...toggle(id, expansion),
    label,
    value,
    empty,
    toggleLabel: tk('kpi.toggle', { label, value, action: action(expansion.expanded === id) }),
  });

  return (
    <dl aria-label={tk('sections.usage')} className={GRID}>
      <MetricsTrendCard
        {...card('tokens', tk('kpi.tokens'), formatTokens(total.totalTokens))}
        icon={<Sigma aria-hidden="true" />}
        detail={tk('kpi.tokensDetail', { value: formatTokens(total.totalTokens / days) })}
        values={byDay.map(day => day.totalTokens)}
        color="var(--chart-share-2)"
        chartCaption={tk('kpi.tokensChart')}
      >
        <MetricsStackedBarChart
          data={rows}
          series={tokenSeries}
          valueFormatter={formatTokens}
          variant="gradient"
          xLabels="auto"
          height={CHART_HEIGHT}
        />
      </MetricsTrendCard>
      <MetricsTrendCard
        {...card('cost', tk('kpi.cost'), formatUsd(total.costUsd))}
        icon={<Coins aria-hidden="true" />}
        detail={tk('kpi.costDetail', { value: formatUsd(total.costUsd / days) })}
        values={byDay.map(day => day.costUsd)}
        color="var(--chart-amber)"
        chartCaption={tk('kpi.costChart')}
      >
        <MetricsStackedBarChart
          data={rows}
          series={[{ dataKey: 'cost', label: tk('kpi.costSeries'), color: 'var(--chart-amber)' }]}
          valueFormatter={formatUsd}
          variant="capped"
          xLabels="auto"
          height={CHART_HEIGHT}
        />
      </MetricsTrendCard>
      <MetricsTrendCard
        {...card('turns', tk('kpi.turns'), String(total.turns))}
        icon={<MessageSquareText aria-hidden="true" />}
        detail={tk('kpi.turnsDetail', { value: formatPerDay(total.turns / days) })}
        values={byDay.map(day => day.turns)}
        color="var(--chart-blue)"
        chartCaption={tk('kpi.turnsChart')}
      >
        <MetricsLineChart
          data={rows}
          series={[{ dataKey: 'turns', label: tk('kpi.turnsSeries'), color: 'var(--chart-blue)' }]}
          height={CHART_HEIGHT}
        />
      </MetricsTrendCard>
      <MetricsTrendCard
        {...card('cacheShare', tk('kpi.cacheShare'), cacheShare === null ? '—' : `${cacheShare}%`)}
        icon={<DatabaseZap aria-hidden="true" />}
        detail={tk('kpi.cacheShareDetail')}
        values={rows.map(row => row.cacheShare)}
        color="var(--chart-purple)"
        chartCaption={tk('kpi.cacheShareChart')}
      >
        <MetricsLineChart
          data={rows}
          series={[{ dataKey: 'cacheShare', label: tk('kpi.cacheShareSeries'), color: 'var(--chart-purple)' }]}
          valueFormatter={value => `${Math.round(value)}%`}
          yDomain={[0, 100]}
          height={CHART_HEIGHT}
        />
      </MetricsTrendCard>
    </dl>
  );
}
