import { SettingsContainer, SettingsRow } from '@mastra/playground-ui/new/settings';
import { useTranslation } from 'react-i18next';

import { FactoryThinkingControl } from '../../FactoryThinkingControl';
import { SettingsSubsection } from '../../SettingsSubsection';
import { ModelRoutingMap } from './ModelRoutingMap';

export function ModelRoutingSection({ factoryId }: { factoryId: string }) {
  const { t } = useTranslation('settings');
  return (
    <SettingsSubsection scope="factory" title={t('routing.title')} description={t('routing.description')}>
      <div className="flex flex-col gap-6">
        <ModelRoutingMap factoryId={factoryId} />
        <SettingsContainer>
          <SettingsRow label={t('models.thinking.label')} description={t('routing.thinkingDescription')}>
            <FactoryThinkingControl factoryId={factoryId} />
          </SettingsRow>
        </SettingsContainer>
      </div>
    </SettingsSubsection>
  );
}
