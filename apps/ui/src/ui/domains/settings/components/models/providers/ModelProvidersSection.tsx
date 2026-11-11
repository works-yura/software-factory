import { Txt } from '@mastra/playground-ui/components/Txt';
import { SettingsContainer } from '@mastra/playground-ui/new/settings';
import { useTranslation } from 'react-i18next';

import { MODEL_DEFAULTS_ANCHORS } from '../../../settingsSections';
import { CustomProvidersSection } from '../../CustomProvidersSection';
import { SettingsSubsection } from '../../SettingsSubsection';
import { ProviderList } from './ProviderList';

/**
 * How Mastra reaches its models: the organization's provider credentials and its own
 * OpenAI-compatible providers, in one section. It plays the part the accounts section plays for a
 * turn-based harness, so every harness shows a default model and then its access.
 */
export function ModelProvidersSection() {
  const { t } = useTranslation('settings');
  return (
    <SettingsSubsection
      id={MODEL_DEFAULTS_ANCHORS.factory}
      scope="org"
      title={t('models.providers.title')}
      description={t('models.providers.description')}
    >
      <div className="flex flex-col gap-4">
        <ProviderList credentialScope="org" />
        <div className="flex flex-col gap-2">
          <Txt as="h4" variant="label">
            {t('models.customProviders')}
          </Txt>
          <SettingsContainer className="p-4">
            <CustomProvidersSection />
          </SettingsContainer>
        </div>
      </div>
    </SettingsSubsection>
  );
}
