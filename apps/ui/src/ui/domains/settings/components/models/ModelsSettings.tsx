import { SettingsContainer } from '@mastra/playground-ui/new/settings';
import { useTranslation } from 'react-i18next';

import { CustomProvidersSection } from '../CustomProvidersSection';
import { SettingsSubsection } from '../SettingsSubsection';
import { ClaudeAccountsSection } from './accounts/ClaudeAccountsSection';
import { ClaudeCodeModelSection, HarnessSwitchSection, useFactoryHarness } from './harness/HarnessSettings';
import { ModelRoutingSection } from './routing/ModelRoutingSection';

/**
 * The harness on top; below it only the settings of the harness this Factory
 * runs on: Mastra's model routing, thinking and custom providers, or Claude
 * Code's model and accounts.
 */
export function ModelsSettings({ factoryId }: { factoryId: string }) {
  const { t } = useTranslation('settings');
  const { harness, descriptor } = useFactoryHarness(factoryId);
  return (
    <div className="flex flex-col gap-8">
      <HarnessSwitchSection factoryId={factoryId} />
      {/* Each harness's own model settings: Mastra's providers, or Claude's model and accounts. */}
      {harness !== undefined && descriptor.setup.modelProvider && (
        <>
          <ModelRoutingSection factoryId={factoryId} />
          <SettingsSubsection scope="org" title={t('models.customProviders')}>
            <SettingsContainer className="p-4">
              <CustomProvidersSection />
            </SettingsContainer>
          </SettingsSubsection>
        </>
      )}
      {harness !== undefined && descriptor.setup.claudeSignIn && (
        <>
          <ClaudeCodeModelSection factoryId={factoryId} />
          <ClaudeAccountsSection />
        </>
      )}
    </div>
  );
}
