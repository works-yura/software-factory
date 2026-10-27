import { SettingsContainer, SettingsRow } from '@mastra/playground-ui/new/settings';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { CommittedInput } from './CommittedInput';
import type { SaveEnvironment } from './CommittedInput';

/**
 * Where the repositories are cloned, the one command that runs there after
 * every repository is set up, then whatever rows the caller adds (the
 * provider's own settings).
 */
export function WorkspaceSetupBlock({
  workdir,
  command,
  disabled,
  onSave,
  children,
}: {
  workdir: string | null;
  command: string | null;
  disabled: boolean;
  onSave: SaveEnvironment;
  children?: ReactNode;
}) {
  const { t } = useTranslation('settings');
  return (
    <SettingsContainer>
      <SettingsRow label={t('environment.workspace.workdir')} description={t('environment.workspace.workdirDescription')}>
        <div className="w-full lg:max-w-96">
          <CommittedInput
            label={t('environment.workspace.workdir')}
            placeholder="/workspace"
            value={workdir ?? ''}
            disabled={disabled}
            onCommit={raw => onSave({ sandboxWorkingDirectory: raw || null })}
          />
        </div>
      </SettingsRow>
      <SettingsRow
        label={t('environment.workspace.setupCommand')}
        description={t('environment.workspace.setupCommandDescription')}
      >
        <div className="w-full lg:max-w-96">
          <CommittedInput
            label={t('environment.workspace.setupCommand')}
            value={command ?? ''}
            placeholder={t('environment.workspace.setupCommandPlaceholder')}
            disabled={disabled}
            onCommit={next => onSave({ workspaceSetupCommand: next || null })}
          />
        </div>
      </SettingsRow>
      {children}
    </SettingsContainer>
  );
}
