import type {
  AgentControllerSessionSettings,
  PermissionPolicy,
  PermissionRules,
  ToolCategory,
} from '@mastra/client-js';
import { SegmentedControl, SegmentedControlItem } from '@mastra/playground-ui/components/SegmentedControl';
import { Switch } from '@mastra/playground-ui/components/Switch';
import { ThemeToggle } from '@mastra/playground-ui/components/ThemeToggle';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { LanguageSwitcher } from '../../../i18n/LanguageSwitcher';

import { loadDoneSound, playDoneSound, saveDoneSound } from '../services/doneSound';
import type { DoneSound } from '../services/doneSound';
import { SettingsContainer, SettingsRow } from '@mastra/playground-ui/new/settings';

import { SettingsSubsection } from './SettingsSubsection';
import { SoundPicker } from './SettingsFields';
import { useThemeOptions } from '../../../i18n/useThemeOptions';

export function GeneralSettings() {
  const { t } = useTranslation();
  const themeOptions = useThemeOptions();
  const [doneSound, setDoneSound] = useState<DoneSound>(() => loadDoneSound());
  const changeDoneSound = (next: DoneSound) => {
    setDoneSound(next);
    saveDoneSound(next);

    playDoneSound(next);
  };
  return (
    <SettingsSubsection scope="personal" title={t('general')} description={t('storedInBrowser')}>
      <SettingsContainer>
        <SettingsRow label={t('language.label')} description={t('language.description')}>
          <LanguageSwitcher />
        </SettingsRow>
        <SettingsRow label={t('theme.label')} description={t('theme.description')}>
          <ThemeToggle options={themeOptions} aria-label={t('theme.label')} />
        </SettingsRow>
        <SettingsRow label={t('completionSound.label')} description={t('completionSound.description')}>
          <SoundPicker value={doneSound} onChange={changeDoneSound} />
        </SettingsRow>
      </SettingsContainer>
    </SettingsSubsection>
  );
}

interface BehaviorSettingsProps {
  /** A Factory on Claude Code: Mastra's smart editing and completion notifications do not apply. */
  claudeCode?: boolean;
  settings: AgentControllerSessionSettings | null;
  onBehaviorChange: (updates: Partial<AgentControllerSessionSettings>) => Promise<unknown>;
  permissions: PermissionRules | null;
  setPermissionForCategory: (category: ToolCategory, policy: PermissionPolicy) => Promise<void>;
}

export function BehaviorSettings({
  claudeCode = false,
  settings,
  onBehaviorChange,
  permissions,
  setPermissionForCategory,
}: BehaviorSettingsProps) {
  const { t } = useTranslation('settings');
  const notificationMode = settings?.notifications ?? 'off';
  return (
    <div className="flex flex-col gap-8">
      <SettingsSubsection
        scope="factory"
        title={t('behavior.general.title')}
        description={claudeCode ? t('behavior.claudeCode.generalDescription') : t('behavior.general.description')}
      >
        <SettingsContainer>
          <SettingsRow label={t('behavior.autoApprove.label')} description={t('behavior.autoApprove.description')}>
            <Toggle
              ariaLabel={t('behavior.autoApprove.label')}
              checked={!!settings?.yolo}
              disabled={!settings}
              onChange={v => onBehaviorChange({ yolo: v })}
            />
          </SettingsRow>
          {!claudeCode && (
          <SettingsRow label={t('behavior.smartEditing.label')} description={t('behavior.smartEditing.description')}>
            <Toggle
              ariaLabel={t('behavior.smartEditing.label')}
              checked={!!settings?.smartEditing}
              disabled={!settings}
              onChange={v => onBehaviorChange({ smartEditing: v })}
            />
          </SettingsRow>
          )}
          {!claudeCode && (
          <SettingsRow label={t('behavior.notifications.label')} description={t('behavior.notifications.description')}>
            <SegmentedControl
              aria-label={t('behavior.notifications.label')}
              value={notificationMode}
              disabled={!settings}
              onValueChange={v => onBehaviorChange({ notifications: v })}
            >
              <SegmentedControlItem value="off">{t('behavior.notifications.off')}</SegmentedControlItem>
              <SegmentedControlItem value="bell">{t('behavior.notifications.bell')}</SegmentedControlItem>
              <SegmentedControlItem value="system">{t('behavior.notifications.system')}</SegmentedControlItem>
              <SegmentedControlItem value="both">{t('behavior.notifications.both')}</SegmentedControlItem>
            </SegmentedControl>
          </SettingsRow>
          )}
        </SettingsContainer>
      </SettingsSubsection>
      {/* Auto-approve allows every category, so the per-category choices have nothing to say until it is off. */}
      {!settings?.yolo && (
        <PermissionsSection
          claudeCode={claudeCode}
          permissions={permissions}
          setPermissionForCategory={setPermissionForCategory}
        />
      )}
    </div>
  );
}

const TOOL_CATEGORIES: readonly ToolCategory[] = ['read', 'edit', 'execute', 'mcp', 'other'];
function PermissionsSection({
  claudeCode,
  permissions,
  setPermissionForCategory,
}: Pick<BehaviorSettingsProps, 'claudeCode' | 'permissions' | 'setPermissionForCategory'>) {
  const { t } = useTranslation('settings');
  return (
    <SettingsSubsection
      scope="factory"
      title={t('behavior.permissions.title')}
      description={claudeCode ? t('behavior.claudeCode.permissionsDescription') : t('behavior.permissions.description')}
    >
      <SettingsContainer>
        {TOOL_CATEGORIES.map(value => (
          <SettingsRow
            key={value}
            label={t(`behavior.permissions.categories.${value}.label`)}
            description={t(`behavior.permissions.categories.${value}.hint`)}
          >
            <PermissionPolicyControl
              category={t(`behavior.permissions.categories.${value}.label`)}
              policy={permissions?.categories?.[value] ?? 'ask'}
              disabled={!permissions}
              onChange={policy => void setPermissionForCategory(value, policy)}
            />
          </SettingsRow>
        ))}
      </SettingsContainer>
    </SettingsSubsection>
  );
}

function PermissionPolicyControl({
  category,
  policy,
  disabled,
  onChange,
}: {
  category: string;
  policy: PermissionPolicy;
  disabled: boolean;
  onChange: (policy: PermissionPolicy) => void;
}) {
  const { t } = useTranslation('settings');
  return (
    <SegmentedControl
      aria-label={t('behavior.permissions.controlLabel', { category })}
      value={policy}
      disabled={disabled}
      onValueChange={onChange}
    >
      <SegmentedControlItem value="allow">{t('behavior.permissions.allow')}</SegmentedControlItem>
      <SegmentedControlItem value="ask">{t('behavior.permissions.ask')}</SegmentedControlItem>
      <SegmentedControlItem value="deny">{t('behavior.permissions.deny')}</SegmentedControlItem>
    </SegmentedControl>
  );
}

function Toggle({
  checked,
  ariaLabel,
  disabled,
  onChange,
}: {
  checked: boolean;
  ariaLabel: string;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <Switch aria-label={ariaLabel} checked={checked} disabled={disabled} onCheckedChange={value => onChange(value)} />
  );
}
