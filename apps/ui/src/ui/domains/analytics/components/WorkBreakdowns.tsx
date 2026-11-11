import { ShareBar } from '@mastra/playground-ui/components/ShareBar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@mastra/playground-ui/components/Tooltip';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { cn } from '@mastra/playground-ui/utils/cn';
import { Gauge, Inbox, Workflow } from 'lucide-react';
import type { ReactNode } from 'react';

import type { FactoryMetrics } from '../../factory/services/metrics';
import { QueueHealthPanel } from '../../factory/components/QueueHealthPanel';
import { translator } from '../../../i18n/t';
import type { StageCatalog } from '../stages';
import { AnalyticsEmptyPreview } from './AnalyticsEmptyPreview';
import type { BreakdownView } from './BreakdownSection';
import { BreakdownSection } from './BreakdownSection';

const tk = translator('analytics');

/** Sequential, largest slice darkest: the order of the mix, not categories to tell apart. */
export const SOURCE_COLORS = [
  'bg-chart-sequential-5',
  'bg-chart-sequential-4',
  'bg-chart-sequential-3',
  'bg-chart-sequential-2',
  'bg-chart-sequential-1',
];

/** Catalog keys for the sources the server reports (`<integration>:<type>`, or `manual`). */
const SOURCE_KEYS: Readonly<Record<string, string>> = {
  'github:issue': 'githubIssue',
  'github:pull-request': 'githubPullRequest',
  'gitlab:issue': 'gitlabIssue',
  'gitlab:merge-request': 'gitlabMergeRequest',
  'linear:issue': 'linearIssue',
  'clickup:task': 'clickupTask',
  manual: 'manual',
};

const EM_DASH = '—';

function sourceLabel(source: string): string {
  const key = SOURCE_KEYS[source];
  return key ? tk(`intake.sources.${key}`) : source;
}

type WorkView = 'queue' | 'intake' | 'coverage';

/** Work → Queue health / Work intake / Automation coverage, as upstream's Metrics page tabbed them. */
export function WorkBreakdowns({
  factoryProjectId,
  metrics,
  stages,
  emptyAction,
}: {
  factoryProjectId: string;
  metrics: FactoryMetrics;
  stages: StageCatalog;
  emptyAction?: ReactNode;
}) {
  const views: BreakdownView<WorkView>[] = [
    {
      value: 'queue',
      label: tk('views.queue.label'),
      shortLabel: tk('views.queue.short'),
      icon: Gauge,
      description: tk('views.queue.description'),
      content: <QueueHealthPanel factoryProjectId={factoryProjectId} emptyAction={emptyAction} />,
    },
    {
      value: 'intake',
      label: tk('views.intake.label'),
      shortLabel: tk('views.intake.short'),
      icon: Inbox,
      description: tk('views.intake.description'),
      content: <SourceMix metrics={metrics} />,
    },
    {
      value: 'coverage',
      label: tk('views.coverage.label'),
      shortLabel: tk('views.coverage.short'),
      icon: Workflow,
      description: tk('views.coverage.description'),
      content: <StageAutomation metrics={metrics} stages={stages} />,
    },
  ];
  return <BreakdownSection title={tk('sections.workBreakdowns')} views={views} defaultView="queue" />;
}

export function SourceMix({ metrics }: { metrics: FactoryMetrics }) {
  const total = metrics.sourceMix.reduce((sum, entry) => sum + entry.count, 0);
  if (total === 0) {
    return <AnalyticsEmptyPreview kind="share" title={tk('intake.empty')} description={tk('intake.emptyDescription')} />;
  }
  // sorted so the color ramp reads largest → smallest
  const slices = [...metrics.sourceMix]
    .sort((a, b) => b.count - a.count)
    .map((entry, index) => ({
      key: entry.source,
      label: sourceLabel(entry.source),
      value: entry.count,
      color: SOURCE_COLORS[index % SOURCE_COLORS.length]!,
    }));
  return <ShareBar slices={slices} formatAmount={count => tk('intake.items', { count })} />;
}

export function StageAutomation({ metrics, stages }: { metrics: FactoryMetrics; stages: StageCatalog }) {
  // rows exist only for stages with ≥1 finished pass
  if (metrics.agentCoverage.length === 0) {
    return (
      <AnalyticsEmptyPreview kind="rows" title={tk('coverage.empty')} description={tk('coverage.emptyDescription')} />
    );
  }
  const describe = (stage: string, byAgent: number, passes: number, pct: number | null, outcomes: string) =>
    pct === null
      ? tk('coverage.describeNone', { stage: stages.label(stage) })
      : `${tk('coverage.describe', { stage: stages.label(stage), pct, byAgent, passes })}${outcomes ? ` — ${outcomes}` : ''}`;

  const rowsByStage = new Map(metrics.agentCoverage.map(row => [row.stage, row]));
  // board stages in column order, then unknown ids last — same rule as stageOrder
  const stageIds = new Set<string>(stages.pipelineStages);
  for (const row of metrics.agentCoverage) {
    stageIds.add(row.stage);
  }
  const ordered = [...stageIds].sort((a, b) => stages.order(a) - stages.order(b) || a.localeCompare(b));

  return (
    <ul className="m-0 flex list-none flex-col p-0">
      {ordered.map(stage => {
        const row = rowsByStage.get(stage);
        const passes = row?.passes ?? 0;
        const byAgent = row?.byAgent ?? 0;
        const pct = passes === 0 ? null : Math.round((byAgent / passes) * 100);
        const outcomes = row && byAgent > 0 ? outcomeSummary(row.outcomes) : '';
        return (
          <li
            key={stage}
            className="group grid grid-cols-[minmax(0,8rem)_1fr_auto] items-center gap-3 rounded-md px-2 py-2.5 transition-colors hover:bg-fill-subtle"
          >
            <Txt as="span" variant="body-sm" tone="muted" className="truncate">
              {stages.label(stage)}
            </Txt>
            <Tooltip>
              <TooltipTrigger
                render={
                  <div
                    role="img"
                    tabIndex={0}
                    aria-label={describe(stage, byAgent, passes, pct, outcomes)}
                    className={cn(
                      'h-2 overflow-hidden rounded-full bg-fill-subtle focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-border-focus',
                    )}
                  >
                    {pct !== null && byAgent > 0 ? (
                      <div
                        className="h-full rounded-full bg-chart-sequential-5 transition-[width] duration-300"
                        style={{ width: `${Math.max(2, pct)}%` }}
                      />
                    ) : null}
                  </div>
                }
              />
              <TooltipContent>
                {pct === null ? tk('coverage.tooltipNone') : tk('coverage.tooltip', { byAgent, passes })}
                {outcomes ? ` · ${outcomes}` : ''}
              </TooltipContent>
            </Tooltip>
            <span className="shrink-0 rounded-full bg-fill-subtle px-2 py-0.5 text-meta text-muted-foreground tabular-nums transition-colors group-hover:bg-fill-hover">
              {pct === null ? EM_DASH : `${pct}%`}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function outcomeSummary(outcomes: FactoryMetrics['agentCoverage'][number]['outcomes']): string {
  const parts: string[] = [];
  if (outcomes.done > 0) parts.push(tk('coverage.outcomes.done', { count: outcomes.done }));
  if (outcomes.canceled > 0) parts.push(tk('coverage.outcomes.canceled', { count: outcomes.canceled }));
  if (outcomes.reworked > 0) parts.push(tk('coverage.outcomes.reworked', { count: outcomes.reworked }));
  if (outcomes.inFlight > 0) parts.push(tk('coverage.outcomes.inFlight', { count: outcomes.inFlight }));
  return parts.join(', ');
}
