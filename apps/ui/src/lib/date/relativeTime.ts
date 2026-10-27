import { differenceInDays, differenceInHours, differenceInMinutes, format, isValid } from 'date-fns';
import { uk } from 'date-fns/locale';

import { currentLanguage } from '../../ui/i18n';
import { translator } from '../../ui/i18n/t';

const tk = translator('app');

/**
 * Compact relative timestamp for dense UI (thread lists, activity rows):
 * "just now", "5m", "3h", "2d", then a short calendar date ("Jun 29") once
 * the value is a week or older. Invalid input renders as an empty string so
 * callers can interpolate without guarding. Follows the UI language.
 *
 * `now` is injectable for deterministic tests; production callers omit it.
 */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  if (!isValid(then)) return '';
  const minutes = differenceInMinutes(now, then);
  if (minutes < 1) return tk('relativeTime.justNow');
  if (minutes < 60) return tk('relativeTime.minutes', { value: minutes });
  const hours = differenceInHours(now, then);
  if (hours < 24) return tk('relativeTime.hours', { value: hours });
  const days = differenceInDays(now, then);
  if (days < 7) return tk('relativeTime.days', { value: days });
  const locale = currentLanguage() === 'uk' ? uk : undefined;
  return format(then, tk('relativeTime.dateFormat'), { locale });
}
