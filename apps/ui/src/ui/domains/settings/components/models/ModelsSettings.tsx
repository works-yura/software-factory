import { SettingsContainer } from '@mastra/playground-ui/new/settings';
import { useTranslation } from 'react-i18next';

import { CustomProvidersSection } from '../CustomProvidersSection';
import { AgentLanguageSection } from './AgentLanguageSection';
import { SettingsSubsection } from '../SettingsSubsection';
import { harnessAccounts } from './accounts/harnessAccounts';
import { HarnessAccountsSection } from './accounts/HarnessAccountsSection';
import { HarnessModelDefaultsSection } from './defaults/HarnessModelDefaultsSection';
import { HarnessSwitchSection, useFactoryHarness } from './harness/HarnessSettings';
import { ModelRoutingSection } from './routing/ModelRoutingSection';

/**
 * The harness on top, then the agents' language (both harnesses follow it), then the default
 * model of every harness alike (`HarnessModelDefaultsSection`); below them only what the harness
 * this Factory runs on needs to reach its models: Mastra's providers, or a turn-based harness's
 * accounts (Claude Code's, Codex's: one section, see `harnessAccounts`).
 */
export function ModelsSettings({ factoryId }: { factoryId: string }) {
  const { t } = useTranslation('settings');
  const { harness, descriptor } = useFactoryHarness(factoryId);
  const accounts = harness !== undefined ? harnessAccounts(descriptor) : undefined;
  return (
    <div className="flex flex-col gap-8">
      <HarnessSwitchSection factoryId={factoryId} />
      <AgentLanguageSection factoryId={factoryId} />
      <HarnessModelDefaultsSection factoryId={factoryId} />
      {/* Each harness's own way to its models: Mastra's providers, or the sign-ins a turn-based harness runs on. */}
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
      {accounts && <HarnessAccountsSection key={accounts.provider} accounts={accounts} />}
    </div>
  );
}
