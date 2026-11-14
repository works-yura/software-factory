import type { AgentControllerSessionSettings } from '@mastra/client-js';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router';

import { translator } from '../../../i18n/t';
import { toast } from '@mastra/playground-ui/components/Toaster';

import { useChatPermissions } from '../../chat/context/useChatPermissions';
import { useChatSessionContext } from '../../chat/context/useChatSessionContext';
import { useSettingsSection } from '../hooks/useSettingsSection';
import { useAgentControllerSettings } from '../../../../hooks/useAgentControllerSettings';
import {
  SettingsUpdateVerificationError,
  useUpdateAgentControllerSettingsMutation,
} from '../../../../hooks/useUpdateAgentControllerSettingsMutation';
import { AGENT_CONTROLLER_ID } from '../../chat/services/constants';
import { AnalyticsSection } from '../../analytics/components/AnalyticsSection';
import { DebugSection } from './DebugSection';
import { EnvironmentSection } from './EnvironmentSection';
import { AccountSettingsSection } from './AccountSettingsSection';
import { FactoryManagementSection } from './FactoryManagementSection';
import { IntakeRoutesSection } from './IntakeRoutesSection';
import { IntakeSection } from './IntakeSection';
import { ConnectionsSection } from './connections/ConnectionsSection';
import { OrganizationSection } from './OrganizationSection';
import { RepositoriesSection } from './RepositoriesSection';
import { SettingsSubsection } from './SettingsSubsection';
import { BehaviorSettings, GeneralSettings } from './SettingsPanel.parts';
import { FactoryBehaviorSettings } from './FactoryBehaviorSettings';
import { useFactoryHarness } from './models/harness/HarnessSettings';
import { MemorySettings } from './MemorySettings';
import { ModelsSettings } from './models/ModelsSettings';

const tk = translator('settings');

function getSettingsUpdateErrorMessage(error: unknown): string {
  if (error instanceof SettingsUpdateVerificationError) return error.message;
  if (error instanceof Error) return tk('panel.updateFailedWith', { message: error.message });
  return tk('panel.updateFailed');
}

export function SettingsPanel() {
  const { t } = useTranslation('settings');
  const section = useSettingsSection();
  const { factoryId } = useParams<{ factoryId: string }>();
  const { sessionId: chatSessionId, resourceEnabled, baseUrl } = useChatSessionContext();
  const { permissions, setPermissionForCategory } = useChatPermissions();
  const hookArgs = {
    agentControllerId: AGENT_CONTROLLER_ID,
    sessionId: chatSessionId,
    baseUrl,
    enabled: resourceEnabled,
  };

  const settingsQuery = useAgentControllerSettings(hookArgs);
  const updateSettingsMutation = useUpdateAgentControllerSettingsMutation(hookArgs);
  const { harness, descriptor } = useFactoryHarness(factoryId ?? '');
  // A harness with per-session permission categories keeps them in Behavior; otherwise the Factory's tool rules do.
  const factoryToolRules = harness !== undefined && !descriptor.supports.sessionPermissions;
  const settings = settingsQuery.data ?? null;

  const onBehaviorChange = (updates: Partial<AgentControllerSessionSettings>) => {
    if (!settings) return Promise.resolve();

    return updateSettingsMutation
      .mutateAsync(updates)
      .catch(error => toast.error(getSettingsUpdateErrorMessage(error)));
  };

  return (
    <>
      {section === 'account' && <AccountSettingsSection />}
      {section === 'organization' && <OrganizationSection />}
      {section === 'preferences' && <GeneralSettings />}
      {section === 'analytics' && <AnalyticsSection />}
      {section === 'factory' && <FactoryManagementSection />}
      {section === 'repositories' && <RepositoriesSection />}
      {section === 'environment' && <EnvironmentSection />}
      {section === 'intake' && <IntakeSection />}
      {section === 'integrations' && <ConnectionsSection />}
      {section === 'models' && factoryId && <ModelsSettings factoryId={factoryId} />}
      {section === 'memory' && factoryId && <MemorySettings factoryId={factoryId} />}
      {section === 'debug' && <DebugSection />}
      {section === 'behavior' && factoryId && factoryToolRules && (
        <FactoryBehaviorSettings factoryId={factoryId} />
      )}
      {section === 'behavior' && !factoryToolRules && (
        <BehaviorSettings
          settings={settings}
          onBehaviorChange={onBehaviorChange}
          permissions={permissions ?? null}
          setPermissionForCategory={setPermissionForCategory}
        />
      )}
    </>
  );
}
