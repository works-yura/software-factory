import { DropdownMenu } from '@mastra/playground-ui/components/DropdownMenu';
import { Check, ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { RangePreset } from '../ranges';
import { RANGE_PRESETS } from '../ranges';

/** The preset window every widget on the page reads. */
export function RangePicker({ rangeDays, onSelect }: { rangeDays: RangePreset; onSelect: (days: RangePreset) => void }) {
  const { t } = useTranslation('analytics');
  const current = t(`range.presets.${rangeDays}`);
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger type="button" aria-label={t('range.label', { range: current })} variant="ghost" size="sm">
        {current}
        <ChevronDown aria-hidden className="text-muted-foreground" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="end" className="min-w-44">
        {RANGE_PRESETS.map(days => (
          <DropdownMenu.Item key={days} onSelect={() => onSelect(days)}>
            <span className="flex-1">{t(`range.presets.${days}`)}</span>
            {days === rangeDays && <Check aria-label={t('range.selected')} />}
          </DropdownMenu.Item>
        ))}
      </DropdownMenu.Content>
    </DropdownMenu>
  );
}
