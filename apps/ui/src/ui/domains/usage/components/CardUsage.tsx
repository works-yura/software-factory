import { Txt } from '@mastra/playground-ui/components/Txt';
import { useTranslation } from 'react-i18next';

import { useWorkItemsUsageQuery } from '../../../../hooks/useUsage';
import { relativeTime } from '../../../../lib/date/relativeTime';
import { formatAggregateCost, formatTokens, harnessName } from '../format';

/** The most runs a card lists; older ones count in its total. */
const RUNS_SHOWN = 5;

/** What a card's runs spent: its total, and each run's harness, model, tokens and estimated cost. */
export function CardUsage({ workItemId, enabled }: { workItemId: string; enabled: boolean }) {
  const { t } = useTranslation('usage');
  const usageQuery = useWorkItemsUsageQuery([workItemId], { enabled });
  const usage = usageQuery.data?.workItems[workItemId];
  if (!usage || usage.total.turns === 0) return null;

  return (
    <section aria-label={t('card.title')} className="flex flex-col gap-1">
      <Txt as="h4" variant="eyebrow" tone="muted" className="m-0">
        {t('card.title')}
      </Txt>
      <Txt as="p" variant="meta" tone="ink" className="m-0 tabular-nums">
        {t('card.total', { tokens: formatTokens(usage.total.totalTokens), cost: formatAggregateCost(usage.total) })}
      </Txt>
      <ul aria-label={t('card.runs')} className="m-0 flex list-none flex-col gap-0.5 p-0">
        {usage.runs.slice(0, RUNS_SHOWN).map(run => (
          <li key={run.kickoffId ?? run.sessionId} className="flex items-baseline gap-2">
            <Txt as="span" variant="meta" tone="muted" className="min-w-0 flex-1 truncate">
              {t('card.run', { harness: harnessName(run.harnessId), model: run.model ?? t('page.unknown.model') })}
            </Txt>
            <Txt as="span" variant="meta" tone="muted" className="shrink-0 tabular-nums">
              {t('card.runTokens', { tokens: formatTokens(run.totalTokens) })} · {formatAggregateCost(run)}
            </Txt>
            <time className="text-muted-foreground text-caption shrink-0" dateTime={run.endedAt}>
              {relativeTime(run.endedAt)}
            </time>
          </li>
        ))}
      </ul>
    </section>
  );
}
