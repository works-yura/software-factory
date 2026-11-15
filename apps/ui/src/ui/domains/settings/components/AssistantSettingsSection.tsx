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
import type { AssistantModelPickerProps } from '@factory/assistant-ui';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import type { ModelCatalogResponse } from '../../../../hooks/useAvailableModels';
import { useFactoryAuth } from '../../../../hooks/useFactoryAuth';
import { AssistantApi } from '../../assistant/AssistantOverlay';
import { ProviderModelPicker } from '../../chat/components/modelPicker/ProviderModelPicker';
import { toProviderInstances } from '../../chat/components/modelPicker/providerInstances';
import { SettingsSubsection } from './SettingsSubsection';

const PICKER_TRIGGER = 'w-full max-w-none border border-border bg-surface2 text-foreground hover:bg-surface3 sm:w-(--field-width)';

/**
 * The assistant's model in Factory's own model picker (the one Settings › Моделі uses): search,
 * providers, the default marked, free models badged. A server that lists provider instances is read
 * the way Factory reads its catalog; a plain list becomes the Mastra instance.
 */
export function AssistantModelPicker({ catalog, value, disabled, onChange }: AssistantModelPickerProps) {
  const { t } = useTranslation('assistant');
  const entries = useMemo(() => {
    const raw = catalog.raw as Partial<ModelCatalogResponse>;
    if (Array.isArray(raw.instances)) return toProviderInstances(raw as ModelCatalogResponse);
    return toProviderInstances({
      models: catalog.models.map(model => ({ id: model.id, provider: model.provider, modelName: model.modelName, hasApiKey: true as const })),
      fallbackModelId: catalog.default?.modelId ?? null,
    });
  }, [catalog]);
  const free = useMemo(() => new Set(catalog.models.filter(model => model.free).map(model => model.id)), [catalog.models]);
  const unavailable = useMemo(
    () => new Map(catalog.models.filter(model => model.available === false).map(model => [model.id, model.unavailableReason ?? t('settings.unavailable')])),
    [catalog.models, t],
  );
  const options = useMemo(
    () =>
      new Map(
        entries.map(entry => [
          entry.instanceId,
          entry.models.map(model => (free.has(model.slug) ? { ...model, badge: 'free' as const } : model)),
        ]),
      ),
    [entries, free],
  );
  const active = entries.find(entry => (value ? entry.models.some(model => model.slug === value) : entry.defaultModel)) ?? entries[0];
  if (!active) return null;
  return (
    <ProviderModelPicker
      activeInstanceId={active.instanceId}
      model={value ?? active.defaultModel ?? ''}
      lockedProvider={entries.length === 1 ? active.driverKind : null}
      instanceEntries={entries}
      modelOptionsByInstance={options}
      triggerClassName={PICKER_TRIGGER}
      triggerAriaLabel={t('settings.model')}
      popupAlign="end"
      disabled={disabled}
      getModelDisabledReason={(_instance, model) => unavailable.get(model) ?? null}
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
