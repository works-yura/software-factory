import { AlertDialog } from '@mastra/playground-ui/components/AlertDialog';
import { Badge } from '@mastra/playground-ui/components/Badge';
import { Button } from '@mastra/playground-ui/components/Button';
import { Combobox } from '@mastra/playground-ui/components/Combobox';
import type { ComboboxOption } from '@mastra/playground-ui/components/Combobox';
import { Input } from '@mastra/playground-ui/components/Input';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { SettingsContainer, SettingsRow } from '@mastra/playground-ui/new/settings';
import { RotateCcw, Stethoscope } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { useAssistantFactories, useAssistantModelCatalog, useAssistantSettings, useSettingsActions } from './api';
import type { AssistantModel, AssistantModelCatalog } from './api';
import { useModelLabel } from './RequestThread';
import { useModelCheck, useModelStatus } from './settings-api';
import type { ProviderState } from './settings-api';
import { RequestTime } from './time';

const ACCESS_RESULTS = ['connected', 'denied', 'failed', 'signed_out'] as const;
type AccessResult = (typeof ACCESS_RESULTS)[number];

/** What the consent round trip came back with (`?assistantAccess=`), if anything. */
function accessResult(search: string): AccessResult | undefined {
  const value = new URLSearchParams(search).get('assistantAccess');
  return (ACCESS_RESULTS as readonly string[]).includes(value ?? '') ? (value as AccessResult) : undefined;
}

type PageLocation = Pick<Location, 'pathname' | 'search' | 'assign'>;
const browserLocation = (): PageLocation | undefined => (typeof window === 'undefined' ? undefined : window.location);

/** What a host picker gets: the catalog as the server sent it, the chosen model (`null`: the default), and how to change it. */
export interface AssistantModelPickerProps {
  catalog: AssistantModelCatalog;
  value: string | null;
  disabled: boolean;
  onChange: (modelId: string) => void;
}

/** A model the server marks as unable to run now. */
const unavailable = (model: AssistantModel) => model.available === false;

/**
 * The fallback picker when the host gives none: the kit's searchable Combobox, the provider and
 * a free badge on each model.
 */
function CatalogCombobox({ catalog, value, disabled, onChange }: AssistantModelPickerProps) {
  const { t } = useTranslation('assistant');
  const modelLabel = useModelLabel();
  const options = useMemo<ComboboxOption[]>(() => {
    const free = (on: boolean | undefined) => (on ? { end: <Badge size="xs" variant="neutral">{t('settings.free')}</Badge> } : {});
    if (catalog.groups.length) {
      // Only what can run is offered here; the host's picker shows the rest disabled, with why.
      return catalog.groups.flatMap(group =>
        group.models
          .filter(model => model.selectable)
          .map(model => ({
            value: model.id,
            label: `${group.label} · ${model.label}`,
            description: model.id,
            keywords: [model.id, group.label, ...(group.harnessLabel ? [group.harnessLabel] : [])],
            ...free(model.free),
          })),
      );
    }
    return catalog.models.map(model => ({
      value: model.id,
      label: model.label ?? modelLabel(model.id),
      description: model.unavailableReason ?? model.id,
      keywords: [model.id, model.provider, ...(model.group ? [model.group] : [])],
      ...free(model.free),
    }));
  }, [catalog, t, modelLabel]);
  return (
    <Combobox
      options={options}
      value={value ?? ''}
      onValueChange={onChange}
      placeholder={
        catalog.default?.modelId
          ? t('settings.modelDefaultIs', { model: catalog.default.label ?? modelLabel(catalog.default.modelId) })
          : t('settings.modelDefault')
      }
      searchPlaceholder={t('settings.searchModels')}
      emptyText={t('settings.noModelFound')}
      disabled={disabled}
      aria-label={t('settings.model')}
    />
  );
}

/** A provider's last outcome as a badge: works, or how it failed. */
function ProviderBadge({ state }: { state: ProviderState['state'] }) {
  const { t } = useTranslation('assistant');
  return (
    <Badge size="sm" variant={state === 'ok' ? 'success' : state === 'rate_limit' || state === 'overloaded' ? 'warning' : 'destructive'}>
      {t(`settings.providerState.${state}`)}
    </Badge>
  );
}

/**
 * Settings › «Помічник» › Модель: the picker (the host's — Factory's own model picker — or the kit's
 * Combobox), which model actually runs and why, how each provider fared last, and «Check the model».
 */
export function AssistantModelSettings({ renderPicker }: { renderPicker?: (props: AssistantModelPickerProps) => ReactNode }) {
  const { t } = useTranslation('assistant');
  const settings = useAssistantSettings();
  const catalog = useAssistantModelCatalog();
  const status = useModelStatus();
  const actions = useSettingsActions();
  const check = useModelCheck();
  const modelLabel = useModelLabel();
  const chosen = settings.data?.modelId ?? null;
  const models = catalog.data?.models ?? [];
  const runnable = catalog.data?.groups.length
    ? catalog.data.groups
        .filter(group => !group.availability || group.availability.state === 'ready' || group.availability.state === 'limited')
        .flatMap(group => group.models.filter(model => model.selectable))
    : models.filter(model => !unavailable(model));
  const onlyFree = runnable.length > 0 && runnable.every(model => model.free === true);
  const defaultModel = catalog.data?.default ?? null;
  const pickerProps: AssistantModelPickerProps | undefined = catalog.data
    ? {
        catalog: catalog.data,
        value: chosen,
        disabled: !settings.data || actions.save.isPending,
        onChange: modelId => actions.save.mutate({ modelId }),
      }
    : undefined;

  return (
    <SettingsContainer>
      {settings.isError ? <Notice variant="destructive">{settings.error.message}</Notice> : null}
      <SettingsRow label={t('settings.model')} description={t('settings.modelDescription')}>
        {catalog.isError ? (
          <Txt as="span" variant="caption" tone="muted">
            {catalog.error.message}
          </Txt>
        ) : catalog.data && models.length === 0 ? (
          <Txt as="span" variant="caption" tone="muted">
            {t('settings.noModels')}
          </Txt>
        ) : pickerProps ? (
          <div className="flex items-center gap-2">
            {renderPicker ? renderPicker(pickerProps) : <CatalogCombobox {...pickerProps} />}
            {chosen ? (
              <Button
                size="sm"
                variant="ghost"
                icon={<RotateCcw />}
                disabled={actions.save.isPending}
                onClick={() => actions.save.mutate({ modelId: null })}
              >
                {t('settings.useDefault')}
              </Button>
            ) : null}
          </div>
        ) : null}
      </SettingsRow>
      {actions.save.isError ? <Notice variant="destructive">{actions.save.error.message}</Notice> : null}
      <SettingsRow label={t('settings.runsOn')} description={t('settings.runsOnDescription')}>
        <Txt as="span" variant="body-sm" data-testid="assistant-effective-model">
          {chosen
            ? t('settings.runsChosen', { model: modelLabel(chosen) })
            : defaultModel?.modelId
              ? t('settings.runsDefault', { model: defaultModel.label ?? modelLabel(defaultModel.modelId) })
              : catalog.data
                ? t('settings.runsNothing')
                : '…'}
        </Txt>
        {!chosen && defaultModel?.reason ? (
          <Txt as="span" variant="caption" tone="muted">
            {defaultModel.reason}
          </Txt>
        ) : null}
      </SettingsRow>
      {onlyFree ? <Notice variant="info">{t('settings.onlyFree')}</Notice> : null}
      <SettingsRow label={t('settings.providers')} description={t('settings.providersDescription')}>
        {status.data?.length ? (
          <ul className="flex flex-col gap-1" aria-label={t('settings.providers')}>
            {status.data.map(provider => (
              <li key={provider.provider} className="flex items-center gap-2" title={provider.detail ?? undefined}>
                <Txt as="span" variant="label">
                  {provider.provider}
                </Txt>
                <ProviderBadge state={provider.state} />
                <Txt as="span" variant="caption" tone="muted">
                  {provider.modelId ? modelLabel(provider.modelId) : null} · <RequestTime value={provider.at} />
                </Txt>
              </li>
            ))}
          </ul>
        ) : (
          <Txt as="span" variant="caption" tone="muted">
            {t('settings.providersUnknown')}
          </Txt>
        )}
      </SettingsRow>
      <SettingsRow label={t('settings.check')} description={t('settings.checkDescription')}>
        <Button size="sm" icon={<Stethoscope />} disabled={check.isPending} onClick={() => check.mutate(undefined)}>
          {check.isPending ? t('settings.checking') : t('settings.check')}
        </Button>
      </SettingsRow>
      {check.data ? (
        check.data.ok ? (
          <Notice variant="success">
            {t('settings.checkOk', { model: modelLabel(check.data.modelId ?? ''), ms: check.data.durationMs, reply: check.data.reply ?? '' })}
          </Notice>
        ) : (
          <Notice variant="destructive">
            {t(`failure.${check.data.failure?.kind ?? 'unknown'}.title`, { model: check.data.modelId ? modelLabel(check.data.modelId) : t('failure.defaultModel') })}
            {check.data.failure?.detail ? ` — ${check.data.failure.detail}` : ''}
          </Notice>
        )
      ) : check.isError ? (
        <Notice variant="destructive">{check.error.message}</Notice>
      ) : null}
    </SettingsContainer>
  );
}

/** Settings › «Помічник» › Доступ до Factory: allowing the assistant to reach Factory as the person. */
export function AssistantFactoryAccessSettings({ location = browserLocation() }: { location?: PageLocation }) {
  const { t } = useTranslation('assistant');
  const factories = useAssistantFactories();
  const actions = useSettingsActions();
  const result = location ? accessResult(location.search) : undefined;
  return (
    <SettingsContainer>
      {result ? <Notice variant={result === 'connected' ? 'success' : 'warning'}>{t(`settings.accessResult.${result}`)}</Notice> : null}
      <SettingsRow label={t('settings.factoryAccess')} description={t('settings.factoryAccessDescription')}>
        <div className="flex items-center gap-2">
          <Txt as="span" variant="caption" tone="muted" data-testid="assistant-access-state">
            {factories.data?.connected ? t('settings.connected') : t('settings.notConnected')}
          </Txt>
          <Button
            size="sm"
            disabled={actions.startAccess.isPending}
            onClick={() =>
              actions.startAccess.mutate(location?.pathname ?? '/', {
                onSuccess: ({ url }) => location?.assign(url),
              })
            }
          >
            {factories.data?.connected ? t('settings.reconnect') : t('settings.connect')}
          </Button>
          {factories.data?.connected ? (
            <Button size="sm" variant="ghost" disabled={actions.disconnect.isPending} onClick={() => actions.disconnect.mutate()}>
              {t('settings.disconnect')}
            </Button>
          ) : null}
        </div>
      </SettingsRow>
      {factories.data?.connected && factories.data.factories.length ? (
        <SettingsRow label={t('settings.reachable')} description={t('settings.reachableDescription')}>
          <Txt as="span" variant="body-sm">
            {factories.data.factories.map(factory => factory.name).join(', ')}
          </Txt>
        </SettingsRow>
      ) : null}
      {factories.isError ? <Notice variant="destructive">{factories.error.message}</Notice> : null}
      {actions.startAccess.isError ? <Notice variant="destructive">{actions.startAccess.error.message}</Notice> : null}
    </SettingsContainer>
  );
}

/** Settings › «Помічник» › Зберігання: how long closed requests are kept, and erasing it all. */
export function AssistantStorageSettings() {
  const { t } = useTranslation('assistant');
  const settings = useAssistantSettings();
  const actions = useSettingsActions();
  const [retention, setRetention] = useState('');

  useEffect(() => {
    if (settings.data) setRetention(String(settings.data.retentionDays));
  }, [settings.data]);

  const retentionValue = Number(retention);
  const retentionChanged = settings.data !== undefined && retention !== '' && retentionValue !== settings.data.retentionDays;

  return (
    <SettingsContainer>
      <SettingsRow label={t('settings.retention')} description={t('settings.retentionDescription')}>
        <form
          className="flex items-center gap-2"
          onSubmit={event => {
            event.preventDefault();
            if (retentionChanged) actions.save.mutate({ retentionDays: retentionValue });
          }}
        >
          <Input
            aria-label={t('settings.retention')}
            type="number"
            min={1}
            max={365}
            className="w-20"
            value={retention}
            onChange={event => setRetention(event.target.value)}
          />
          <Txt as="span" variant="caption" tone="muted">
            {t('settings.days')}
          </Txt>
          <Button type="submit" size="sm" aria-label={t('settings.saveRetention')} disabled={!retentionChanged || actions.save.isPending}>
            {t('settings.save')}
          </Button>
        </form>
      </SettingsRow>
      {actions.save.isError ? <Notice variant="destructive">{actions.save.error.message}</Notice> : null}
      <SettingsRow label={t('settings.clear')} description={t('settings.clearDescription')}>
        <AlertDialog>
          <AlertDialog.Trigger
            render={
              <Button size="sm" variant="destructive-ghost" disabled={actions.clear.isPending}>
                {t('settings.clear')}
              </Button>
            }
          />
          <AlertDialog.Content>
            <AlertDialog.Header>
              <AlertDialog.Title>{t('settings.clearConfirmTitle')}</AlertDialog.Title>
              <AlertDialog.Description>{t('settings.clearConfirmDescription')}</AlertDialog.Description>
            </AlertDialog.Header>
            <AlertDialog.Footer>
              <AlertDialog.Cancel>{t('actions.cancel')}</AlertDialog.Cancel>
              <AlertDialog.Action onClick={() => actions.clear.mutate()}>{t('settings.clear')}</AlertDialog.Action>
            </AlertDialog.Footer>
          </AlertDialog.Content>
        </AlertDialog>
      </SettingsRow>
      {actions.clear.isSuccess ? (
        <Notice variant="success">{t('settings.cleared')}</Notice>
      ) : actions.clear.isError ? (
        <Notice variant="destructive">{actions.clear.error.message}</Notice>
      ) : null}
    </SettingsContainer>
  );
}
