import { AgentLanguageSection } from './AgentLanguageSection';
import { harnessAccounts } from './accounts/harnessAccounts';
import { HarnessAccountsSection } from './accounts/HarnessAccountsSection';
import { HarnessModelDefaultsSection } from './defaults/HarnessModelDefaultsSection';
import { HarnessSwitchSection, useFactoryHarness } from './harness/HarnessSettings';
import { ModelProvidersSection } from './providers/ModelProvidersSection';

/**
 * The harness on top, then the agents' language, then the same two sections for whichever harness
 * the Factory runs on: its default model (`HarnessModelDefaultsSection`) and how it reaches its
 * models: Mastra's providers, or a turn-based harness's accounts (Claude Code's, Codex's: one
 * section, see `harnessAccounts`).
 */
export function ModelsSettings({ factoryId }: { factoryId: string }) {
  const { harness, descriptor } = useFactoryHarness(factoryId);
  const accounts = harness !== undefined ? harnessAccounts(descriptor) : undefined;
  return (
    <div className="flex flex-col gap-8">
      <HarnessSwitchSection factoryId={factoryId} />
      <AgentLanguageSection factoryId={factoryId} />
      <HarnessModelDefaultsSection factoryId={factoryId} />
      {/* Each harness's own way to its models: Mastra's providers, or the sign-ins a turn-based harness runs on. */}
      {harness !== undefined && descriptor.setup.modelProvider && <ModelProvidersSection />}
      {accounts && <HarnessAccountsSection key={accounts.provider} accounts={accounts} />}
    </div>
  );
}
