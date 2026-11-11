import { SettingsContainer } from '@mastra/playground-ui/new/settings';
import { useTranslation } from 'react-i18next';

import { CustomProvidersSection } from '../CustomProvidersSection';
import { AgentLanguageSection } from './AgentLanguageSection';
import { SettingsSubsection } from '../SettingsSubsection';
import { ClaudeAccountsSection } from './accounts/ClaudeAccountsSection';
import { HarnessModelDefaultsSection } from './defaults/HarnessModelDefaultsSection';
import { HarnessSwitchSection, useFactoryHarness } from './harness/HarnessSettings';
import { ModelRoutingSection } from './routing/ModelRoutingSection';

/**
 * The harness on top, then the agents' language (both harnesses follow it), then the default
 * model of every harness alike (`HarnessModelDefaultsSection`); below them only what the harness
 * this Factory runs on needs to reach its models: Mastra's providers, or Claude Code's accounts.
 */
export function ModelsSettings({ factoryId }: { factoryId: string }) {
  const { t } = useTranslation('settings');
  const { harness, descriptor } = useFactoryHarness(factoryId);
  return (
    <div className="flex flex-col gap-8">
      <HarnessSwitchSection factoryId={factoryId} />
      <AgentLanguageSection factoryId={factoryId} />
      <HarnessModelDefaultsSection factoryId={factoryId} />
      {/* Each harness's own way to its models: Mastra's providers, or Claude's accounts. */}
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
      {harness !== undefined && descriptor.setup.claudeSignIn && <ClaudeAccountsSection />}
    </div>
  );
}
