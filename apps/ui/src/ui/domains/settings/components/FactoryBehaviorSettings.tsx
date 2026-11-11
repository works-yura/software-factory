import type { AgentControllerSessionSettings, PermissionPolicy, PermissionRules, ToolCategory } from '@mastra/client-js';
import { toast } from '@mastra/playground-ui/components/Toaster';

import { useFactoryToolPermissions } from '../../../../hooks/useFactoryToolPermissions';
import { useFactoryHarness } from './models/harness/HarnessSettings';
import { translator } from '../../../i18n/t';
import { BehaviorSettings } from './SettingsPanel.parts';

const tk = translator('settings');

/**
 * Settings → Behavior of a Factory on a turn-based harness (Claude Code, Codex). Auto-approve and
 * the per-category tool permissions are stored on the Factory (such a Factory has no
 * agent-controller session to keep them in) and the server turns them into the CLI's rules for
 * every turn (Claude Code's allow, ask and deny rules; Codex's sandbox and approval policy).
 * Smart editing and completion notifications belong to Mastra's own agent and
 * UI, so they are left out.
 */
export function FactoryBehaviorSettings({ factoryId }: { factoryId: string }) {
  const { permissions, save } = useFactoryToolPermissions(factoryId);
  const { descriptor } = useFactoryHarness(factoryId);

  const fail = (error: unknown): void => {
    toast.error(error instanceof Error ? error.message : tk('behavior.turnHarness.saveFailed'));
  };

  const settings = permissions
    ? ({ yolo: permissions.yolo, notifications: 'off', smartEditing: false } as AgentControllerSessionSettings)
    : null;
  const rules = permissions ? ({ categories: permissions.categories, tools: {} } as PermissionRules) : null;

  return (
    <BehaviorSettings
      turnHarness={descriptor.label}
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
