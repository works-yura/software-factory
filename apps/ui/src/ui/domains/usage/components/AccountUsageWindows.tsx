import { Meter } from '@mastra/playground-ui/components/Meter';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { useTranslation } from 'react-i18next';

import type { AccountUsageView } from '../../../../api/types';
import { formatUsageTime, orderedWindows, windowLabel } from '../format';

/**
 * An account's allowance as bars: one per window its provider reports (5-hour, weekly, a model's
 * weekly cap), how much is used and when it resets, and when it was last read. Every harness's
 * accounts read the same way.
 */
export function AccountUsageWindows({ label, usage }: { label: string; usage: AccountUsageView }) {
  const { t } = useTranslation('usage');
  const windows = orderedWindows(usage.windows);
  const problem = usage.unavailable;
  const problemText = problem
    ? problem.reason === 'failed'
      ? problem.message
        ? t('accounts.unavailable.failed', { message: problem.message })
        : t('accounts.unavailable.failedPlain')
      : t(`accounts.unavailable.${problem.reason}`)
    : undefined;

  return (
    <div role="group" aria-label={t('accounts.label', { label })} className="flex flex-col gap-1.5 pt-1">
      {windows.map(window => {
        const name = windowLabel(window);
        const percent = Math.round(window.usedPercent);
        return (
          <div key={window.id} className="grid grid-cols-[6.5rem_minmax(0,1fr)_auto] items-center gap-2">
            <Txt as="span" variant="meta" tone="muted" className="truncate">
              {name}
            </Txt>
            <Meter
              value={percent}
              max={100}
              aria-label={name}
              aria-valuetext={t('windowUsed', { window: name, percent })}
              className={percent >= 100 ? 'text-destructive-foreground' : undefined}
            />
            <Txt as="span" variant="meta" tone="muted" className="text-right tabular-nums">
              {t('percentUsed', { percent })}
              {window.resetsAt ? ` · ${t('resetsAt', { time: formatUsageTime(window.resetsAt) })}` : ''}
            </Txt>
          </div>
        );
      })}
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
