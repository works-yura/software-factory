import type { UsageGroup } from '@factory/harness/usage';
import { MetricsCard } from '@mastra/playground-ui/components/MetricsCard';
import { MetricsKpiCard } from '@mastra/playground-ui/components/MetricsKpiCard';
import type { MetricsLineChartSeries } from '@mastra/playground-ui/components/MetricsLineChart';
import { MetricsShareList } from '@mastra/playground-ui/components/MetricsShareList';
import type { MetricsShareListRow } from '@mastra/playground-ui/components/MetricsShareList';
import { MetricsStackedBarChart } from '@mastra/playground-ui/components/MetricsStackedBarChart';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { SegmentedControl, SegmentedControlItem } from '@mastra/playground-ui/components/SegmentedControl';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { UsageSummaryResponse } from '../../../../api/types';
import { useUsageSummaryQuery } from '../../../../hooks/useUsage';
import { currentLanguage } from '../../../i18n';
import { SettingsSubsection } from '../../settings/components/SettingsSubsection';
import { formatAggregateCost, formatTokens, formatUsd, harnessName } from '../format';

const PERIODS = ['7', '30', '90'] as const;
type Period = (typeof PERIODS)[number];
type Scope = 'factory' | 'all';
type Breakdown = 'harness' | 'model' | 'account' | 'factory' | 'role' | 'session';
const BREAKDOWNS = ['harness', 'model', 'role', 'session', 'account', 'factory'] as const satisfies readonly Breakdown[];
type DailyView = 'tokens' | 'cost';

const DAY_MS = 86_400_000;

const TOKEN_SERIES = (t: (key: 'category.input' | 'category.cacheRead' | 'category.cacheWrite' | 'category.output') => string) =>
  [
    { dataKey: 'input', label: t('category.input'), color: 'var(--chart-share-1)' },
    { dataKey: 'cacheRead', label: t('category.cacheRead'), color: 'var(--chart-share-3)' },
    { dataKey: 'cacheWrite', label: t('category.cacheWrite'), color: 'var(--chart-share-4)' },
    { dataKey: 'output', label: t('category.output'), color: 'var(--chart-share-2)' },
  ] satisfies MetricsLineChartSeries[];

/** The period's UTC days, ending today. */
export function usagePeriod(days: number, now = new Date()): { from: string; to: string } {
  const to = now.toISOString().slice(0, 10);
  const from = new Date(Date.parse(`${to}T00:00:00Z`) - (days - 1) * DAY_MS).toISOString().slice(0, 10);
  return { from, to };
}

function dayLabel(day: string): string {
  return new Intl.DateTimeFormat(currentLanguage(), { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${day}T00:00:00Z`));
}

function groupsOf(summary: UsageSummaryResponse, by: Breakdown): UsageGroup[] {
  if (by === 'harness') return summary.byHarness;
  if (by === 'model') return summary.byModel;
  if (by === 'account') return summary.byAccount;
  if (by === 'role') return summary.byRole;
  if (by === 'session') return summary.bySession;
  return summary.byFactory;
}

/**
 * Settings › Usage: what the agents of this Factory (or every Factory) spent over a period, for
 * every harness alike: tokens, the cost at API list prices, per day, and split by harness, model,
 * the role a card run played, the sessions that spent most, account and Factory. The roles and
 * sessions follow upstream's run usage (`factory.run.ended`) and Studio's Usage card (Agents,
 * Models, Threads).
 */
export function UsageSection({ factoryId }: { factoryId: string }) {
  const { t } = useTranslation('usage');
  const [period, setPeriod] = useState<Period>('30');
  const [scope, setScope] = useState<Scope>('factory');
  const [daily, setDaily] = useState<DailyView>('tokens');
  const [breakdown, setBreakdown] = useState<Breakdown>('harness');
  const query = useUsageSummaryQuery({
    ...usagePeriod(Number(period)),
    ...(scope === 'factory' ? { factoryProjectId: factoryId } : {}),
  });
  const summary = query.data;
  const loading = query.isPending;

  const label = (by: Breakdown, key: string): string => {
    if (!key) return t(`page.unknown.${by === 'harness' ? 'model' : by}`);
    if (by === 'harness') return harnessName(key);
    if (by === 'account') return summary?.labels.accounts[key] ?? key;
    if (by === 'factory') return summary?.labels.factories[key] ?? key;
    if (by === 'session') return summary?.labels.sessions[key] ?? t('page.unknown.session');
    return key;
  };

  const rows: MetricsShareListRow[] = summary
    ? groupsOf(summary, breakdown).map(group => ({
        key: group.key || '∅',
        label: label(breakdown, group.key),
        share: group.totalTokens,
        value: formatTokens(group.totalTokens),
        cells: [formatAggregateCost(group)],
      }))
    : [];

  const total = summary?.total;
  const inputTotal = total ? total.totals.inputTokens + total.totals.cacheReadTokens + total.totals.cacheWriteTokens : 0;
  const cacheShare = total && inputTotal > 0 ? Math.round((total.totals.cacheReadTokens / inputTotal) * 100) : 0;
  const chartData = (summary?.byDay ?? []).map(day => ({
    time: dayLabel(day.day),
    input: day.totals.inputTokens,
    cacheRead: day.totals.cacheReadTokens,
    cacheWrite: day.totals.cacheWriteTokens,
    output: day.totals.outputTokens,
    cost: day.costUsd,
  }));

  return (
    <SettingsSubsection
      title={t('page.title')}
      description={t('page.description')}
      action={
        <div className="flex flex-wrap items-center gap-2">
          <SegmentedControl aria-label={t('page.scope')} size="sm" value={scope} onValueChange={setScope}>
            <SegmentedControlItem value="factory">{t('page.scopes.factory')}</SegmentedControlItem>
            <SegmentedControlItem value="all">{t('page.scopes.all')}</SegmentedControlItem>
          </SegmentedControl>
          <SegmentedControl aria-label={t('page.period')} size="sm" value={period} onValueChange={setPeriod}>
            {PERIODS.map(days => (
              <SegmentedControlItem key={days} value={days}>
                {t(`page.periods.${days}`)}
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
        </div>
      }
    >
      {query.isError ? (
        <Notice variant="destructive">{t('page.error')}</Notice>
      ) : (
        <div className="flex flex-col gap-4">
          <div role="group" aria-label={t('page.title')} className="flex flex-wrap gap-3">
            <Kpi label={t('page.kpi.tokens')} value={total ? formatTokens(total.totalTokens) : undefined} />
            <Kpi label={t('page.kpi.cost')} value={total ? formatUsd(total.costUsd) : undefined} />
            <Kpi label={t('page.kpi.turns')} value={total ? String(total.turns) : undefined} />
            <Kpi label={t('page.kpi.cacheShare')} value={total ? `${cacheShare}%` : undefined} />
          </div>
          <MetricsCard>
            <MetricsCard.TopBar>
              <MetricsCard.TitleAndDescription>
                <MetricsCard.Title>{daily === 'tokens' ? t('page.daily.title') : t('page.daily.costTitle')}</MetricsCard.Title>
                <MetricsCard.Description>
                  {daily === 'tokens' ? t('page.daily.description') : t('page.daily.costDescription')}
                </MetricsCard.Description>
              </MetricsCard.TitleAndDescription>
              <MetricsCard.Tabs<DailyView> value={daily} onValueChange={setDaily}>
                <MetricsCard.Tab value="tokens">{t('page.daily.tokensTab')}</MetricsCard.Tab>
                <MetricsCard.Tab value="cost">{t('page.daily.costTab')}</MetricsCard.Tab>
              </MetricsCard.Tabs>
            </MetricsCard.TopBar>
            <MetricsStackedBarChart
              data={chartData}
              series={daily === 'tokens' ? TOKEN_SERIES(t) : [{ dataKey: 'cost', label: t('page.breakdown.cost'), color: 'var(--chart-share-1)' }]}
              valueFormatter={daily === 'tokens' ? formatTokens : formatUsd}
              variant={daily === 'tokens' ? 'gradient' : 'capped'}
              xLabels="auto"
              isLoading={loading}
            />
          </MetricsCard>
          <MetricsCard>
            <MetricsCard.TopBar>
              <MetricsCard.TitleAndDescription>
                <MetricsCard.Title>{t('page.breakdown.title')}</MetricsCard.Title>
                <MetricsCard.Description>{t('page.breakdown.description')}</MetricsCard.Description>
              </MetricsCard.TitleAndDescription>
              <MetricsCard.Tabs<Breakdown> value={breakdown} onValueChange={setBreakdown}>
                {BREAKDOWNS.map(by => (
                  <MetricsCard.Tab key={by} value={by}>
                    {t(`page.breakdown.by.${by}`)}
                  </MetricsCard.Tab>
                ))}
              </MetricsCard.Tabs>
            </MetricsCard.TopBar>
            <MetricsShareList
              rows={rows}
              valueLabel={t('page.breakdown.tokens')}
              columns={[{ label: t('page.breakdown.cost'), width: 'w-20' }]}
              overflow="more"
              isLoading={loading}
              emptyState={t('page.breakdown.empty')}
            />
          </MetricsCard>
          <Txt as="p" variant="meta" tone="muted">
            {t('cost.note')}
            {total && total.unpricedTurns > 0 ? ` ${t('cost.partlyUnpriced', { count: total.unpricedTurns })}` : ''}
          </Txt>
        </div>
      )}
    </SettingsSubsection>
  );
}

function Kpi({ label, value }: { label: string; value: string | undefined }) {
  return (
    <MetricsKpiCard className="min-w-40">
      <MetricsKpiCard.Label>{label}</MetricsKpiCard.Label>
      {value === undefined ? <MetricsKpiCard.Loading /> : <MetricsKpiCard.Value>{value}</MetricsKpiCard.Value>}
    </MetricsKpiCard>
  );
}
