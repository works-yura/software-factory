import type { AgentControllerSessionSettings, PermissionPolicy, PermissionRules, ToolCategory } from '@mastra/client-js';
import { toast } from '@mastra/playground-ui/components/Toaster';

import { useFactoryToolPermissions } from '../../../../hooks/useFactoryToolPermissions';
import { translator } from '../../../i18n/t';
import { BehaviorSettings } from './SettingsPanel.parts';

const tk = translator('settings');

/**
 * Settings → Behavior of a Factory on Claude Code. Auto-approve and the
 * per-category tool permissions are stored on the Factory (a Claude Code
 * Factory has no agent-controller session to keep them in) and the server
 * turns them into the CLI's allow, ask and deny rules for every turn.
 * Smart editing and completion notifications belong to Mastra's own agent and
 * UI, so they are left out.
 */
export function ClaudeBehaviorSettings({ factoryId }: { factoryId: string }) {
  const { permissions, save } = useFactoryToolPermissions(factoryId);

  const fail = (error: unknown): void => {
    toast.error(error instanceof Error ? error.message : tk('behavior.claudeCode.saveFailed'));
  };

  const settings = permissions
    ? ({ yolo: permissions.yolo, notifications: 'off', smartEditing: false } as AgentControllerSessionSettings)
    : null;
  const rules = permissions ? ({ categories: permissions.categories, tools: {} } as PermissionRules) : null;

  return (
    <BehaviorSettings
      claudeCode
      settings={settings}
      onBehaviorChange={updates =>
        permissions && updates.yolo !== undefined
          ? save({ ...permissions, yolo: updates.yolo }).catch(fail)
          : Promise.resolve()
      }
      permissions={rules}
      setPermissionForCategory={(category: ToolCategory, policy: PermissionPolicy) =>
        permissions
          ? save({ ...permissions, categories: { ...permissions.categories, [category]: policy } }).then(
              () => undefined,
              fail,
            )
          : Promise.resolve()
      }
    />
  );
}
