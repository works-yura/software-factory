import type { PricedUsageTurn, UsageAggregate, UsageTokenTotals } from '@factory/harness/usage';
import { Popover, PopoverContent, PopoverTrigger } from '@mastra/playground-ui/components/Popover';
import { TokenBudget, TokenBudgetDetail } from '@mastra/playground-ui/components/TokenBudget';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { useQueryClient } from '@tanstack/react-query';
import { Coins, ScrollText } from 'lucide-react';
import { useContext, useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { queryKeys } from '../../../../api/keys';
import { useSessionUsageQuery } from '../../../../hooks/useUsage';
import { ChatRuntimeContext } from '../../chat/context/ChatRuntimeContext';
import { ChatSessionContext } from '../../chat/context/ChatSessionContext';
import { formatAggregateCost, formatTokens, formatUsd } from '../format';

/** How long after a turn's last step the recorded row is read again (the server writes it as the turn ends). */
const RECORD_SETTLE_MS = 1_500;

const CATEGORIES = ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens'] as const;
const CATEGORY_KEYS = {
  inputTokens: 'category.input',
  cacheReadTokens: 'category.cacheRead',
  cacheWriteTokens: 'category.cacheWrite',
  outputTokens: 'category.output',
} as const;

function UsageTable({ last, total }: { last: PricedUsageTurn | undefined; total: UsageAggregate }) {
  const { t } = useTranslation('usage');
  const cell = 'text-right tabular-nums';
  const row = (label: string, lastValue: string | undefined, totalValue: string) => (
    <tr key={label}>
      <th scope="row" className="text-muted-foreground pr-3 text-left font-normal">
        {label}
      </th>
      {last ? <td className={`${cell} pr-3`}>{lastValue}</td> : null}
      <td className={cell}>{totalValue}</td>
    </tr>
  );
  const tokens = (totals: UsageTokenTotals | undefined, key: (typeof CATEGORIES)[number]) =>
    totals ? formatTokens(totals[key]) : undefined;
  return (
    <table className="text-caption w-full">
      <thead>
        <tr className="text-muted-foreground">
          <td />
          {last ? <th className={`${cell} pr-3 font-normal`}>{t('session.lastTurn')}</th> : null}
          <th className={`${cell} font-normal`}>{t('session.total')}</th>
        </tr>
      </thead>
      <tbody>
        {CATEGORIES.map(key => row(t(CATEGORY_KEYS[key]), tokens(last?.totals, key), formatTokens(total.totals[key])))}
        {total.totals.reasoningTokens > 0
          ? row(
              t('category.reasoning'),
              last ? formatTokens(last.totals.reasoningTokens) : undefined,
              formatTokens(total.totals.reasoningTokens),
            )
          : null}
        {row(
          t('page.kpi.cost'),
          last ? (last.costSource === 'unpriced' ? t('cost.unpriced') : formatUsd(last.costUsd)) : undefined,
          formatAggregateCost(total),
        )}
      </tbody>
    </table>
  );
}

/**
 * The session's token usage in the status line: its total, and how full the context of its last
 * turn was. The popover splits the last turn and the session by input, cache and output, with
 * the cost at API list prices. Every harness's session reads the same way.
 */
export function SessionUsageStatus() {
  const { t } = useTranslation('usage');
  const sessionId = useContext(ChatSessionContext)?.sessionId;
  const runtime = useContext(ChatRuntimeContext);
  const queryClient = useQueryClient();
  const usageQuery = useSessionUsageQuery(sessionId);
  const liveTokens = runtime?.usage?.totalTokens;
  const runsStarted = runtime?.runsStarted;

  // A step's usage arrives while the turn runs; the turn's row is written as it ends.
  useEffect(() => {
    if (!sessionId || (liveTokens === undefined && !runsStarted)) return;
    const timer = setTimeout(() => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.sessionUsage(sessionId) });
    }, RECORD_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [sessionId, liveTokens, runsStarted, queryClient]);

  const usage = usageQuery.data?.usage;
  if (!usage || usage.total.turns === 0) return null;
  const last = usage.turns.at(-1);
  const context = usage.context;
  const tokens = formatTokens(usage.total.totalTokens);

  return (
    <Popover>
      <PopoverTrigger variant="ghost" size="sm" aria-label={t('session.trigger', { tokens })} className="gap-2">
        <span className="text-muted-foreground inline-flex items-center gap-1 tabular-nums">
          <Coins className="size-3.5" aria-hidden />
          {tokens}
        </span>
        {context?.window ? (
          <TokenBudget label={t('session.context')} tokens={context.tokens} threshold={context.window} />
        ) : null}
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="flex w-80 flex-col gap-3">
        <div className="flex items-baseline justify-between gap-2">
          <Txt as="h3" variant="column" tone="ink">
            {t('session.title')}
          </Txt>
          <Txt as="span" variant="meta" tone="muted">
            {t('session.turns', { count: usage.total.turns })}
          </Txt>
        </div>
        <UsageTable last={usage.turns.length > 1 ? last : undefined} total={usage.total} />
        {context ? (
          context.window ? (
            <TokenBudgetDetail
              icon={<ScrollText />}
              label={t('session.context')}
              tokens={context.tokens}
              threshold={context.window}
              description={t('session.contextValue', {
                tokens: formatTokens(context.tokens),
                window: formatTokens(context.window),
              })}
            />
          ) : (
            <Txt as="p" variant="meta" tone="muted">
              {t('session.contextUnknown', { tokens: formatTokens(context.tokens) })}
            </Txt>
          )
        ) : null}
        <Txt as="p" variant="meta" tone="faint">
          {t('cost.note')}
          {usage.total.unpricedTurns > 0 && usage.total.unpricedTurns < usage.total.turns
            ? ` ${t('cost.partlyUnpriced', { count: usage.total.unpricedTurns })}`
            : ''}
        </Txt>
      </PopoverContent>
    </Popover>
  );
}
