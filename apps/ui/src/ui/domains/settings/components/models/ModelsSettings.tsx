import { SettingsContainer } from '@mastra/playground-ui/new/settings';
import { useTranslation } from 'react-i18next';

import { CustomProvidersSection } from '../CustomProvidersSection';
import { SettingsSubsection } from '../SettingsSubsection';
import { ModelRoutingSection } from './routing/ModelRoutingSection';

export function ModelsSettings({ factoryId }: { factoryId: string }) {
  const { t } = useTranslation('settings');
  return (
    <div className="flex flex-col gap-8">
      <ModelRoutingSection factoryId={factoryId} />
      <SettingsSubsection scope="org" title={t('models.customProviders')}>
        <SettingsContainer className="p-4">
          <CustomProvidersSection />
        </SettingsContainer>
      </SettingsSubsection>
    </div>
  );
}
