import { Popover, PopoverContent, PopoverTrigger } from '@mastra/playground-ui/components/Popover';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { Settings2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { settingsSectionPath } from '../../settings/settingsSections';

/** The board's phases own automation now: the popover says so and links to the board's settings. */
export function BoardAutomationSettings({ factoryProjectId }: { factoryProjectId: string }) {
  const { t } = useTranslation('board');
  return (
    <Popover>
      <PopoverTrigger
        variant="default"
        size="icon-sm"
        aria-label={t('automationSettings.title')}
        tooltip={t('automationSettings.title')}
      >
        <Settings2 aria-hidden />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 max-w-[calc(100vw-2rem)]" aria-label={t('automationSettings.title')}>
        <div className="flex flex-col gap-1">
          <Txt as="h2" variant="subheading">
            {t('automationSettings.heading')}
          </Txt>
          <Txt variant="caption" tone="muted">
            {t('automationSettings.ownedByBoard')}{' '}
            <Link to={settingsSectionPath(factoryProjectId, 'board')} className="underline underline-offset-2">
              {t('automationSettings.editBoard')}
            </Link>
          </Txt>
        </div>
      </PopoverContent>
    </Popover>
  );
}
