import { effectiveUsedPercent, tightestUsageWindow, usageResetsInMs } from '@factory/harness/usage';
import { Popover, PopoverContent, PopoverTrigger } from '@mastra/playground-ui/components/Popover';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { UsageLimitRing } from '@mastra/playground-ui/components/UsageLimit';
import { useQueryClient } from '@tanstack/react-query';
import { useContext, useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import type { UsageLimitsAccount } from '../../../../api/types';
import { useSessionUsageQuery, useUsageLimitsQuery } from '../../../../hooks/useUsage';
import { ChatRuntimeContext } from '../../chat/context/ChatRuntimeContext';
import { ChatSessionContext } from '../../chat/context/ChatSessionContext';
import { formatDuration, formatResetsIn, formatUsageTime, windowLabel } from '../format';
import { useMinuteClock } from '../useMinuteClock';
import { UsageWindowRows, usageProblemText } from './AccountUsageWindows';

/** How long after a turn's last step the account's windows are read again (the turn's stream updates them). */
const LIMITS_SETTLE_MS = 1_500;

/** The account the session's latest turn ran on, from its recorded turns; every harness records it alike. */
function useSessionAccountId(sessionId: string | undefined): string | undefined {
  const turns = useSessionUsageQuery(sessionId).data?.usage.turns ?? [];
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const accountId = turns[index]?.accountId;
    if (accountId) return accountId;
  }
  return undefined;
}

/** Opened: asks the providers again (at most once a minute per account) and lists every window. */
function LimitsDetail({ stored, now }: { stored: UsageLimitsAccount; now: number }) {
  const { t } = useTranslation('usage');
  const refreshed = useUsageLimitsQuery({ refresh: true }).data?.accounts.find(entry => entry.accountId === stored.accountId);
  const account = refreshed ?? stored;
  const usage = account.usage;
  const problem = usageProblemText(usage);
  return (
    <>
      <div className="flex flex-col gap-0.5">
        <Txt as="h3" variant="column" tone="ink">
          {t('limits.title')}
        </Txt>
        <Txt as="span" variant="meta" tone="muted" className="truncate">
          {t('limits.account', { harness: account.harnessName, account: account.label })}
        </Txt>
      </div>
      <UsageWindowRows windows={usage.windows} now={now} />
      {problem ? (
        <Txt as="p" variant="meta" tone="muted">
          {t('accounts.stale')}
        </Txt>
      ) : null}
      <Txt as="p" variant="meta" tone="faint">
        {t('accounts.updated', { time: formatUsageTime(usage.checkedAt) })}
      </Txt>
    </>
  );
}

/**
 * The session's account allowance in the status line: a ring for the window closest to its limit
 * (amber from 80 % used, red from 95 %), its share and when it resets; the popover lists every
 * window. It reads the windows the harness's usage facet supplies for the account the session's
 * latest turn ran on, so every harness that reports limits shows them the same way, and one that
 * reports none (an API key) shows nothing.
 */
export function UsageLimitsStatus() {
  const { t } = useTranslation('usage');
  const sessionId = useContext(ChatSessionContext)?.sessionId;
  const runtime = useContext(ChatRuntimeContext);
  const queryClient = useQueryClient();
  const accountId = useSessionAccountId(sessionId);
  const limitsQuery = useUsageLimitsQuery({ enabled: Boolean(accountId) });
  const now = useMinuteClock();
  const liveTokens = runtime?.usage?.totalTokens;

  // A running turn's stream updates the account's windows; read them again as it goes.
  useEffect(() => {
    if (!accountId || liveTokens === undefined) return;
    const timer = setTimeout(() => {
      void queryClient.invalidateQueries({ queryKey: ['usage', 'limits'] });
    }, LIMITS_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [accountId, liveTokens, queryClient]);

  const account = limitsQuery.data?.accounts.find(entry => entry.accountId === accountId);
  const tightest = account ? tightestUsageWindow(account.usage.windows, now) : undefined;
  if (!account || !tightest) return null;

  const name = windowLabel(tightest);
  const percent = Math.round(effectiveUsedPercent(tightest, now));
  const left = usageResetsInMs(tightest, now);
  const resetsIn = formatResetsIn(tightest, now);
  const label = t('limits.trigger', {
    account: account.label,
    window: name,
    percent,
    resets: resetsIn ?? t('limits.noReset'),
  });

  return (
    <Popover>
      <PopoverTrigger variant="ghost" size="sm" aria-label={label} tooltip={label}>
        <UsageLimitRing label={name} percent={percent} valueText={t('windowUsed', { window: name, percent })}>
          <span>{t('percentUsed', { percent })}</span>
          {/* A narrow status line keeps the share; when it resets is in the tooltip and the popover. */}
          {left ? <span className="text-muted-foreground @max-md/status:hidden">{formatDuration(left)}</span> : null}
        </UsageLimitRing>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="flex w-96 flex-col gap-3">
        <LimitsDetail stored={account} now={now} />
      </PopoverContent>
    </Popover>
  );
}
