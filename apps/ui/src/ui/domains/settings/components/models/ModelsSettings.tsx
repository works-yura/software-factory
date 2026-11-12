import { AgentLanguageSection } from './AgentLanguageSection';
import { HarnessModelDefaultsSection } from './defaults/HarnessModelDefaultsSection';
import { HarnessConnectionsSection } from './harness/HarnessConnectionsSection';
import { HarnessSwitchSection, useFactoryHarness } from './harness/HarnessSettings';
import { ModelProvidersSection } from './providers/ModelProvidersSection';

/**
 * The harness on top, then the agents' language, then the same two sections for whichever harness
 * the Factory runs on: its default model (`HarnessModelDefaultsSection`) and how it reaches its
 * models, as its descriptor says — Mastra's providers, or the connector its accounts are connected
 * through in Settings › Підключення (ADR-0036).
 */
export function ModelsSettings({ factoryId }: { factoryId: string }) {
  const { harness, descriptor } = useFactoryHarness(factoryId);
  return (
    <div className="flex flex-col gap-8">
      <HarnessSwitchSection factoryId={factoryId} />
      <AgentLanguageSection factoryId={factoryId} />
      <HarnessModelDefaultsSection factoryId={factoryId} />
      {harness !== undefined && descriptor.setup.modelProvider && <ModelProvidersSection />}
      {harness !== undefined && descriptor.setup.accounts && (
        <HarnessConnectionsSection key={descriptor.id} factoryId={factoryId} descriptor={descriptor} />
      )}
    </div>
  );
}
