import type { UsageWindow } from '@factory/harness/usage';
import { effectiveUsedPercent } from '@factory/harness/usage';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { UsageLimitRow } from '@mastra/playground-ui/components/UsageLimit';
import { useTranslation } from 'react-i18next';

import type { AccountUsageView } from '../../../../api/types';
import { translator } from '../../../i18n/t';
import { formatUsageTime, orderedWindows, windowDetail, windowLabel } from '../format';
import { useMinuteClock } from '../useMinuteClock';

const tu = translator('usage');

/**
 * Windows as rows: name, a bar that turns amber from 80 % used and red from 95 %, the share used,
 * and beneath it when the window resets. A window whose reset has passed reads as empty. The
 * accounts section, the status line's popover and the Analytics limits card all draw them so.
 */
export function UsageWindowRows({ windows, now }: { windows: ReadonlyArray<UsageWindow>; now: number }) {
  const { t } = useTranslation('usage');
  return (
    <div className="flex flex-col gap-2">
      {orderedWindows(windows).map(window => {
        const name = windowLabel(window);
        const percent = Math.round(effectiveUsedPercent(window, now));
        return (
          <UsageLimitRow
            key={window.id}
            label={name}
            percent={percent}
            valueText={t('windowUsed', { window: name, percent })}
            value={t('percentUsed', { percent })}
            detail={windowDetail(window, now)}
          />
        );
      })}
    </div>
  );
}

/** Why there is nothing newer to show, or nothing at all. */
export function usageProblemText(usage: AccountUsageView): string | undefined {
  const problem = usage.unavailable;
  if (!problem) return undefined;
  if (problem.reason !== 'failed') return tu(`accounts.unavailable.${problem.reason}`);
  return problem.message ? tu('accounts.unavailable.failed', { message: problem.message }) : tu('accounts.unavailable.failedPlain');
}

/**
 * An account's allowance: one row per window its provider reports (5-hour, weekly, a model's weekly
 * cap, extra usage), how much is used and when it resets, and when it was last read. Every harness's
 * accounts read the same way.
 */
export function AccountUsageWindows({ label, usage }: { label: string; usage: AccountUsageView }) {
  const { t } = useTranslation('usage');
  const now = useMinuteClock();
  const windows = usage.windows;
  const problemText = usageProblemText(usage);

  return (
    <div role="group" aria-label={t('accounts.label', { label })} className="flex flex-col gap-1.5 pt-1">
      {windows.length > 0 ? <UsageWindowRows windows={windows} now={now} /> : null}
      {problemText && windows.length > 0 ? (
        <Txt as="p" variant="meta" tone="muted">
          {t('accounts.stale')}
        </Txt>
      ) : null}
      {problemText && windows.length === 0 ? (
        <Txt as="p" variant="meta" tone="muted">
          {problemText}
        </Txt>
      ) : null}
      {windows.length > 0 && (
        <Txt as="p" variant="meta" tone="faint">
          {t('accounts.updated', { time: formatUsageTime(usage.checkedAt) })}
        </Txt>
      )}
    </div>
  );
}
