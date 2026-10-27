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
  scope: 'personal' | 'factory';
  factoryId: string | undefined;
  models: AvailableModelOption[];
  sessionId: string | undefined;
}

export function MemorySettings({ scope, factoryId, models, sessionId }: MemorySettingsProps) {
  const { anyConnected, providersKnown } = useProviderConnectionState();
  const factoryView = scope === 'factory' && factoryId;
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
              to={settingsSectionPath(factoryId, scope === 'factory' ? 'models' : 'personal-models')}
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
      description={factoryView ? t('memory.descriptionFactory') : t('memory.descriptionPersonal')}
      scope={scope}
    >
      <SettingsContainer>
        {factoryView ? (
          <OMSection key="factory" factoryId={factoryId} models={models} />
        ) : (
          <OMSection key="personal" sessionId={sessionId} models={models} />
        )}
      </SettingsContainer>
    </SettingsSubsection>
  );
}
