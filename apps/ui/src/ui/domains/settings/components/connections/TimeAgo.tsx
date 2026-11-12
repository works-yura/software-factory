import { Tooltip, TooltipContent, TooltipTrigger } from '@mastra/playground-ui/components/Tooltip';
import { useTranslation } from 'react-i18next';

import { relativeTime } from '../../../../../lib/date/relativeTime';
import { currentLanguage } from '../../../../i18n';

/**
 * «18 хв тому» in the UI language, the full date in a tooltip — the kit's `RelativeTimestamp`
 * speaks English only («18m ago»).
 */
export function TimeAgo({ value, className }: { value: string; className?: string }) {
  const { t } = useTranslation('settings');
  const short = relativeTime(value);
  const recent = Date.now() - new Date(value).getTime() < 7 * 86_400_000;
  const full = new Intl.DateTimeFormat(currentLanguage() === 'uk' ? 'uk' : 'en', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
  return (
    <Tooltip>
      <TooltipTrigger render={<time dateTime={value} tabIndex={0} className={`whitespace-nowrap tabular-nums ${className ?? ''}`} />}>
        {recent && /\d/.test(short) ? t('connections.time.ago', { time: short }) : short}
      </TooltipTrigger>
      <TooltipContent>{full}</TooltipContent>
    </Tooltip>
  );
}
