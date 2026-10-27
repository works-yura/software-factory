import { Brain } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { buttonVariants } from '@mastra/playground-ui/components/Button';
import { EmptyState } from '@mastra/playground-ui/components/EmptyState';
import { SettingsContainer } from '@mastra/playground-ui/new/settings';

import type { AvailableModelOption } from '../../../../hooks/useAvailableModels';
import { useProviderConnectionState } from '../hooks/useProviderConnectionState';
import { settingsSectionPath } from '../settingsSections';
import { SettingsSubsection } from './SettingsSubsection';
import { OMSection } from './OMSection';

interface MemorySettingsProps {
  factoryId: string | undefined;
  models: AvailableModelOption[];
}

export function MemorySettings({ factoryId, models }: MemorySettingsProps) {
  const { anyConnected, providersKnown } = useProviderConnectionState();
  const { t } = useTranslation('settings');

  if (providersKnown && !anyConnected) {
    return (
      <EmptyState
        as="h2"
        iconSlot={<Brain />}
        titleSlot={t('memory.empty.title')}
        descriptionSlot={t('memory.empty.description')}
        actionSlot={
          factoryId ? (
            <Link
              to={settingsSectionPath(factoryId, 'models')}
              className={buttonVariants({ variant: 'primary' })}
            >
              {t('memory.empty.action')}
            </Link>
          ) : undefined
        }
      />
    );
  }

  return (
    <SettingsSubsection
      title={t('memory.title')}
      description={t('memory.descriptionFactory')}
      scope="factory"
    >
      <SettingsContainer>{factoryId && <OMSection factoryId={factoryId} models={models} />}</SettingsContainer>
    </SettingsSubsection>
  );
}
