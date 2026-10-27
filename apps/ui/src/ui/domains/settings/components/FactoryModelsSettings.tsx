import { SettingsContainer } from '@mastra/playground-ui/new/settings';
import { useTranslation } from 'react-i18next';

import type { AvailableModelOption } from '../../../../hooks/useAvailableModels';
import { useProviderConnectionState } from '../hooks/useProviderConnectionState';
import { CustomProvidersSection } from './CustomProvidersSection';
import { FactoryDefaultModelSection } from './FactoryDefaultModelSection';
import { SettingsSubsection } from './SettingsSubsection';
import { ProviderAccessSection } from './ProviderAccessSection';

export function FactoryModelsSettings({ models }: { models: AvailableModelOption[] }) {
  const { anyConnected, providersKnown } = useProviderConnectionState();
  const { t } = useTranslation('settings');

  const providerSubsections = (
    <>
      <ProviderAccessSection description={anyConnected ? undefined : t('models.connectToUnlock')} />
      <SettingsSubsection scope="org" title={t('models.customProviders')}>
        <SettingsContainer className="p-4">
          <CustomProvidersSection />
        </SettingsContainer>
      </SettingsSubsection>
    </>
  );
  const factoryDefaultsSubsection = (
    <SettingsSubsection
      scope="factory"
      title={t('models.factoryDefaults.title')}
      description={t('models.factoryDefaults.description')}
    >
      <SettingsContainer>
        {(!providersKnown || anyConnected) && <FactoryDefaultModelSection models={models} />}
      </SettingsContainer>
    </SettingsSubsection>
  );

  if (providersKnown && !anyConnected) {
    return (
      <div className="flex flex-col gap-8">
        {factoryDefaultsSubsection}
        {providerSubsections}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      {factoryDefaultsSubsection}
      {providerSubsections}
    </div>
  );
}
