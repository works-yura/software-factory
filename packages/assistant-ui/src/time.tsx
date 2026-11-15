import { Tooltip, TooltipContent, TooltipTrigger } from '@mastra/playground-ui/components/Tooltip';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * How long ago, in the app's language (as apps/ui's `relativeTime`): `now`, `5m`, `3h`, `2d`, then
 * the date. The list and the thread both say it this way.
 */
export function requestAge(value: string, t: TFunction<'assistant'>, language: string | undefined, now = Date.now()): string {
  const at = new Date(value);
  const diff = Math.max(0, now - at.getTime());
  if (diff < MINUTE) return t('time.now');
  if (diff < HOUR) return t('time.minutes', { count: Math.floor(diff / MINUTE) });
  if (diff < DAY) return t('time.hours', { count: Math.floor(diff / HOUR) });
  if (diff < 7 * DAY) return t('time.days', { count: Math.floor(diff / DAY) });
  return new Intl.DateTimeFormat(language, { day: 'numeric', month: 'short' }).format(at);
}

/** A moment as `requestAge` says it, with the full date and time (in the app's language) on hover. */
export function RequestTime({ value, label }: { value: string; label?: string }) {
  const { t, i18n } = useTranslation('assistant');
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return null;
  const full = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(at);
  return (
    <Tooltip>
      <TooltipTrigger render={<time dateTime={at.toISOString()} tabIndex={0} className="rounded-sm whitespace-nowrap tabular-nums" />}>
        <span aria-hidden="true">{requestAge(value, t, i18n.language)}</span>
        <span className="sr-only">{[label, full].filter(Boolean).join(' ')}</span>
      </TooltipTrigger>
      <TooltipContent>{label ? `${label} ${full}` : full}</TooltipContent>
    </Tooltip>
  );
}
