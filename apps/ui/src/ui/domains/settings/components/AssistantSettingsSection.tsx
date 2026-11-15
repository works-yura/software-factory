import {
  AssistantAgentPreview,
  AssistantBehaviorSettings,
  AssistantFactoryAccessSettings,
  AssistantModelSettings,
  AssistantProactivitySettings,
  AssistantSkillsSettings,
  AssistantSources,
  AssistantStorageSettings,
} from '@factory/assistant-ui';
import type { AssistantModelCatalog, AssistantModelPickerProps, ModelAvailability } from '@factory/assistant-ui';
import type { ServerProviderModel } from '@factory/harness/models/contracts';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router';

import { useFactoryAuth } from '../../../../hooks/useFactoryAuth';
import { AssistantApi } from '../../assistant/AssistantOverlay';
import { ProviderModelPicker } from '../../chat/components/modelPicker/ProviderModelPicker';
import { toProviderInstances } from '../../chat/components/modelPicker/providerInstances';
import type { ProviderInstanceEntry } from '../../chat/components/modelPicker/providerInstances';
import { connectorPath, settingsSectionPath } from '../settingsSections';
import { SettingsSubsection } from './SettingsSubsection';

const PICKER_TRIGGER = 'w-full max-w-none border border-border bg-surface2 text-foreground hover:bg-surface3 sm:w-(--field-width)';

/** A group's availability as the picker's instance state: ready (or limited) runs; anything else is greyed with why. */
function groupStatus(availability: ModelAvailability | undefined): { status: 'ready' | 'warning' | 'error'; isAvailable: boolean } {
  if (!availability || availability.state === 'ready') return { status: 'ready', isAvailable: true };
  if (availability.state === 'limited') return { status: 'warning', isAvailable: true };
  return { status: 'error', isAvailable: false };
}

/** Why a group cannot run now, in the viewer's words (its own reason, or the state; with when it comes back). */
function availabilityReason(availability: ModelAvailability | undefined, t: (key: string, options?: Record<string, unknown>) => string): string | undefined {
  if (!availability || availability.state === 'ready') return undefined;
  const state = availability.reason ?? t(`settings.availability.${availability.state}`);
  return availability.until ? `${state} · ${t('settings.availability.until', { at: new Date(availability.until).toLocaleString() })}` : state;
}

/**
 * The catalog's groups (a harness with one credential: «Claude Code · Claude sign-in», «xAI · API
 * key», «OpenCode account» …) as the model picker's provider instances: its search and sidebar of
 * groups, the default marked, free models badged, non-selectable models greyed with why.
 */
export function catalogInstances(
  catalog: AssistantModelCatalog,
  t: (key: string, options?: Record<string, unknown>) => string,
): { entries: ProviderInstanceEntry[]; disabled: Map<string, string> } {
  const defaultId = catalog.default?.modelId ?? null;
  const disabled = new Map<string, string>();
  if (!catalog.groups.length) {
    const entries = toProviderInstances({
      models: catalog.models.map(model => ({ id: model.id, provider: model.provider, modelName: model.modelName, hasApiKey: true as const })),
      fallbackModelId: defaultId,
    }).map(entry => ({
      ...entry,
      models: entry.models.map(model => (catalog.models.find(candidate => candidate.id === model.slug)?.free ? { ...model, badge: 'free' as const } : model)),
    }));
    return { entries, disabled };
  }
  const entries = catalog.groups.map(group => {
    const groupReason = availabilityReason(group.availability, t);
    const groupDefault = group.models.some(model => model.id === defaultId) ? defaultId : null;
    const models: ServerProviderModel[] = group.models.map(model => {
      const reason = model.selectable ? undefined : (availabilityReason(model.availability, t) ?? groupReason ?? t('settings.unavailable'));
      if (reason) disabled.set(model.id, reason);
      return {
        slug: model.id,
        name: model.label,
        isCustom: false,
        capabilities: null,
        ...(model.id === defaultId ? { isDefault: true } : {}),
        ...(model.free ? { badge: 'free' as const } : {}),
        ...(model.legacy ? { isLegacy: true } : {}),
      };
    });
    const selection = groupDefault ? { instanceId: group.id, model: groupDefault } : null;
    return {
      instanceId: group.id,
      driverKind: group.harness ?? group.id,
      displayName: group.credentialLabel && !group.label.includes(group.credentialLabel) ? `${group.label} · ${group.credentialLabel}` : group.label,
      enabled: true,
      ...groupStatus(group.availability),
      needsSetup: group.availability?.state === 'no_credentials',
      defaultModel: groupDefault,
      factoryDefault: null,
      catalogDefault: selection as ProviderInstanceEntry['catalogDefault'],
      appliesToRunningSessions: false,
      acceptsHandoff: false,
      ...(groupReason ? { reason: groupReason } : {}),
      ...(group.availability?.connector ? { connector: group.availability.connector } : {}),
      models,
    } satisfies ProviderInstanceEntry;
  });
  return { entries, disabled };
}

/**
 * The assistant's model in Factory's own model picker (the one Settings › Моделі uses): search, the
 * catalog's groups with their credential and availability, the default marked, free models badged,
 * models that cannot run greyed with why, and a group without credentials links to its connection.
 */
export function AssistantModelPicker({ catalog, value, disabled, onChange }: AssistantModelPickerProps) {
  const { t } = useTranslation('assistant');
  const navigate = useNavigate();
  const { factoryId } = useParams<{ factoryId: string }>();
  const { entries, disabled: reasons } = useMemo(() => catalogInstances(catalog, t as never), [catalog, t]);
  const options = useMemo(() => new Map(entries.map(entry => [entry.instanceId, entry.models])), [entries]);
  const active =
    entries.find(entry => entry.models.some(model => model.slug === (value ?? catalog.default?.modelId))) ??
    entries.find(entry => entry.isAvailable) ??
    entries[0];
  if (!active) return null;
  const openSetup = (instanceId: string) => {
    if (!factoryId) return;
    const connector = entries.find(entry => entry.instanceId === instanceId)?.connector;
    void navigate(connector ? connectorPath(factoryId, connector, { connect: true }) : settingsSectionPath(factoryId, 'models'));
  };
  return (
    <ProviderModelPicker
      activeInstanceId={active.instanceId}
      model={value ?? catalog.default?.modelId ?? ''}
      lockedProvider={entries.length === 1 ? active.driverKind : null}
      instanceEntries={entries}
      modelOptionsByInstance={options}
      triggerClassName={PICKER_TRIGGER}
      triggerAriaLabel={t('settings.model')}
      popupAlign="end"
      disabled={disabled}
      getModelDisabledReason={(_instance, model) => reasons.get(model) ?? null}
      onOpenProviderSetup={openSetup}
      onInstanceModelChange={(_instance, model) => onChange(model)}
    />
  );
}

/**
 * Settings › «Помічник» (personal): everything that drives the person's assistant, in one place —
 * the model, the base instructions, the skills, the sources, what it does by itself, Factory access,
 * what the agent sees, and storage. Invisible to Factories and the organization's admins.
 */
export function AssistantSettingsSection() {
  const { t } = useTranslation('settings');
  const auth = useFactoryAuth().data;
  if (auth && !(auth.authEnabled && auth.authenticated && auth.user?.organizationId)) {
    return <Notice variant="info">{t('assistantPage.needsOrganization')}</Notice>;
  }
  const section = (key: 'model' | 'behavior' | 'skills' | 'sources' | 'proactivity' | 'access' | 'preview' | 'storage') => ({
    id: key,
    scope: 'personal' as const,
    title: t(`assistantPage.${key}.title`),
    description: t(`assistantPage.${key}.description`),
  });
  return (
    <AssistantApi>
      <SettingsSubsection {...section('model')}>
        <AssistantModelSettings renderPicker={props => <AssistantModelPicker {...props} />} />
      </SettingsSubsection>
      <SettingsSubsection {...section('behavior')}>
        <AssistantBehaviorSettings />
      </SettingsSubsection>
      <SettingsSubsection {...section('skills')}>
        <AssistantSkillsSettings />
      </SettingsSubsection>
      <SettingsSubsection {...section('sources')}>
        <AssistantSources />
      </SettingsSubsection>
      <SettingsSubsection {...section('proactivity')}>
        <AssistantProactivitySettings />
      </SettingsSubsection>
      <SettingsSubsection {...section('access')}>
        <AssistantFactoryAccessSettings />
      </SettingsSubsection>
      <SettingsSubsection {...section('preview')}>
        <AssistantAgentPreview />
      </SettingsSubsection>
      <SettingsSubsection {...section('storage')}>
        <AssistantStorageSettings />
      </SettingsSubsection>
    </AssistantApi>
  );
}
