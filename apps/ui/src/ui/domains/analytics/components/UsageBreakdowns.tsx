import type { UsageGroup } from '@factory/harness/usage';
import { ShareBar } from '@mastra/playground-ui/components/ShareBar';
import type { ShareBarSlice } from '@mastra/playground-ui/components/ShareBar';
import { Bot, Building2, Cpu, KeyRound, MessagesSquare, UserCog } from 'lucide-react';

import type { UsageSummaryResponse } from '../../../../api/types';
import { translator } from '../../../i18n/t';
import { formatAggregateCost, formatTokens, harnessName } from '../../usage/format';
import { AnalyticsEmptyPreview } from './AnalyticsEmptyPreview';
import type { BreakdownView } from './BreakdownSection';
import { BreakdownSection } from './BreakdownSection';

const tk = translator('analytics');
const tu = translator('usage');

export type UsageBreakdown = 'harness' | 'model' | 'role' | 'session' | 'account' | 'factory';

/** Categorical: harnesses, models and accounts are kinds to tell apart, not an order. */
const SHARE_COLORS = ['bg-chart-share-1', 'bg-chart-share-2', 'bg-chart-share-3', 'bg-chart-share-4', 'bg-chart-share-5'];
const SHOWN = SHARE_COLORS.length;

const ICONS = { harness: Bot, model: Cpu, role: UserCog, session: MessagesSquare, account: KeyRound, factory: Building2 };

function groupsOf(summary: UsageSummaryResponse, by: UsageBreakdown): UsageGroup[] {
  if (by === 'harness') return summary.byHarness;
  if (by === 'model') return summary.byModel;
  if (by === 'account') return summary.byAccount;
  if (by === 'role') return summary.byRole;
  if (by === 'session') return summary.bySession;
  return summary.byFactory;
}

/** A group's key as people know it: the harness's name, the account's label, the session's title. */
export function usageGroupLabel(summary: UsageSummaryResponse, by: UsageBreakdown, key: string): string {
  if (!key) return tu(`page.unknown.${by === 'harness' ? 'model' : by}`);
  if (by === 'harness') return harnessName(key);
  if (by === 'account') return summary.labels.accounts[key] ?? key;
  if (by === 'factory') return summary.labels.factories[key] ?? key;
  if (by === 'session') return summary.labels.sessions[key] ?? tu('page.unknown.session');
  return key;
}

/** Usage → by Harness / Model / Role / Session / Account (and Factory, when every Factory is counted). */
export function UsageBreakdowns({ summary, allFactories }: { summary: UsageSummaryResponse; allFactories: boolean }) {
  const breakdowns: UsageBreakdown[] = ['harness', 'model', 'role', 'session', 'account', ...(allFactories ? (['factory'] as const) : [])];
  const views: BreakdownView<UsageBreakdown>[] = breakdowns.map(by => ({
    value: by,
    label: tk(`views.${by}.label`),
    icon: ICONS[by],
    description: tk(`views.${by}.description`),
    content: <UsageShare summary={summary} by={by} />,
  }));
  return <BreakdownSection title={tk('sections.usageBreakdowns')} views={views} defaultView="harness" />;
}

function UsageShare({ summary, by }: { summary: UsageSummaryResponse; by: UsageBreakdown }) {
  const groups = groupsOf(summary, by).filter(group => group.totalTokens > 0);
  if (groups.length === 0) {
    return <AnalyticsEmptyPreview kind="share" title={tk('usage.empty')} description={tk('usage.emptyDescription')} />;
  }
  // The server ranks by spend; the bar reads by tokens, largest first.
  const slices: ShareBarSlice[] = [...groups]
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .map((group, index) => ({
      key: group.key || '∅',
      label: usageGroupLabel(summary, by, group.key),
      value: group.totalTokens,
      color: SHARE_COLORS[index] ?? 'bg-chart-share-rest',
      detail: formatAggregateCost(group),
    }));
  return (
    <ShareBar
      slices={slices}
      limit={SHOWN}
      formatValue={formatTokens}
      formatAmount={value => tk('usage.tokens', { value: formatTokens(value) })}
    />
  );
}
