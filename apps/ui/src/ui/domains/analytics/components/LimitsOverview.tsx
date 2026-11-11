import { effectiveUsedPercent, tightestUsageWindow } from '@factory/harness/usage';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { SectionCard } from '@mastra/playground-ui/components/SectionCard';
import { Skeleton } from '@mastra/playground-ui/components/Skeleton';
import { Txt } from '@mastra/playground-ui/components/Txt';

import type { UsageLimitsAccount } from '../../../../api/types';
import { useUsageLimitsQuery } from '../../../../hooks/useUsage';
import { translator } from '../../../i18n/t';
import { UsageWindowRows, usageProblemText } from '../../usage/components/AccountUsageWindows';
import { formatUsageTime } from '../../usage/format';
import { useMinuteClock } from '../../usage/useMinuteClock';

const tk = translator('analytics');
const tu = translator('usage');

/** How close the account is to a limit now: its tightest window's share. */
function tightness(account: UsageLimitsAccount, now: number): number {
  const window = tightestUsageWindow(account.usage.windows, now);
  return window ? effectiveUsedPercent(window, now) : -1;
}

function AccountCard({ account, now }: { account: UsageLimitsAccount; now: number }) {
  const { usage } = account;
  const problem = usageProblemText(usage);
  const description = account.disabled ? tk('limits.harnessOff', { harness: account.harnessName }) : account.harnessName;
  return (
    <SectionCard title={account.label} description={description} contentClassName="flex flex-col gap-2">
      <div role="group" aria-label={tu('accounts.label', { label: account.label })} className="flex flex-col gap-2">
        {usage.windows.length > 0 ? <UsageWindowRows windows={usage.windows} now={now} /> : null}
        {problem ? (
          <Txt as="p" variant="meta" tone="muted" className="m-0">
            {usage.windows.length > 0 ? tu('accounts.stale') : problem}
          </Txt>
        ) : null}
        <Txt as="p" variant="meta" tone="faint" className="m-0">
          {tu('accounts.updated', { time: formatUsageTime(usage.checkedAt) })}
        </Txt>
      </div>
    </SectionCard>
  );
}

/**
 * Settings › Analytics › Limits: every sign-in of every harness that reports allowances, one card
 * each, with all its windows (5-hour, weekly, a model's weekly cap, extra usage). The account
 * closest to a limit comes first. Opening it asks the providers again, at most once a minute per
 * account; harnesses without subscription limits (API keys) have no card.
 */
export function LimitsOverview() {
  const query = useUsageLimitsQuery({ refresh: true });
  const now = useMinuteClock();
  if (query.isError) return <Notice variant="destructive">{tk('limits.error')}</Notice>;
  if (!query.data) {
    return (
      <div role="status" aria-label={tk('limits.loading')} className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Skeleton className="h-40 w-full rounded-2xl" />
        <Skeleton className="h-40 w-full rounded-2xl" />
      </div>
    );
  }
  const accounts = [...query.data.accounts].sort((a, b) => tightness(b, now) - tightness(a, now));
  if (accounts.length === 0) {
    return (
      <Txt as="p" variant="body-sm" tone="muted" className="m-0">
        {tk('limits.empty')}
      </Txt>
    );
  }
  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
      {accounts.map(account => (
        <AccountCard key={account.accountId} account={account} now={now} />
      ))}
    </div>
  );
}
