import { AlertDialog } from '@mastra/playground-ui/components/AlertDialog';
import { Button } from '@mastra/playground-ui/components/Button';
import { Input } from '@mastra/playground-ui/components/Input';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@mastra/playground-ui/components/Select';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { SettingsContainer, SettingsRow } from '@mastra/playground-ui/new/settings';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useAssistantFactories, useAssistantModels, useAssistantSettings, useSettingsActions } from './api';

const ACCESS_RESULTS = ['connected', 'denied', 'failed', 'signed_out'] as const;
type AccessResult = (typeof ACCESS_RESULTS)[number];
/** The Select's value for «the organization's default» (no model of the person's own). */
const DEFAULT_MODEL = 'default';

/** What the consent round trip came back with (`?assistantAccess=`), if anything. */
function accessResult(search: string): AccessResult | undefined {
  const value = new URLSearchParams(search).get('assistantAccess');
  return (ACCESS_RESULTS as readonly string[]).includes(value ?? '') ? (value as AccessResult) : undefined;
}

/**
 * Account › «Помічник» (personal): the model (one of the organization's), how long closed requests
 * are kept, the assistant's access to Factory, and erasing it all. Nothing here is visible to a
 * Factory or to the organization's admins.
 */
export function AssistantSettings({ location = typeof window === 'undefined' ? undefined : window.location }: { location?: Pick<Location, 'pathname' | 'search' | 'assign'> }) {
  const { t } = useTranslation('assistant');
  const settings = useAssistantSettings();
  const models = useAssistantModels();
  const factories = useAssistantFactories();
  const actions = useSettingsActions();
  const [retention, setRetention] = useState('');
  const result = location ? accessResult(location.search) : undefined;

  useEffect(() => {
    if (settings.data) setRetention(String(settings.data.retentionDays));
  }, [settings.data]);

  const retentionValue = Number(retention);
  const retentionChanged = settings.data !== undefined && retention !== '' && retentionValue !== settings.data.retentionDays;

  return (
    <SettingsContainer>
      {result ? (
        <Notice variant={result === 'connected' ? 'success' : 'warning'}>{t(`settings.accessResult.${result}`)}</Notice>
      ) : null}
      {settings.isError ? <Notice variant="destructive">{settings.error.message}</Notice> : null}
      <SettingsRow label={t('settings.model')} description={t('settings.modelDescription')}>
        {models.isError ? (
          <Txt as="span" variant="caption" tone="muted">
            {models.error.message}
          </Txt>
        ) : models.data?.length === 0 ? (
          <Txt as="span" variant="caption" tone="muted">
            {t('settings.noModels')}
          </Txt>
        ) : (
          <Select
            value={settings.data?.modelId ?? DEFAULT_MODEL}
            disabled={!settings.data || actions.save.isPending}
            onValueChange={value => actions.save.mutate({ modelId: value === DEFAULT_MODEL ? null : value })}
          >
            <SelectTrigger size="sm" aria-label={t('settings.model')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={DEFAULT_MODEL}>{t('settings.modelDefault')}</SelectItem>
              {models.data?.map(model => (
                <SelectItem key={model.id} value={model.id}>
                  {model.id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </SettingsRow>
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
          <Button
            type="submit"
            size="sm"
            aria-label={t('settings.saveRetention')}
            disabled={!retentionChanged || actions.save.isPending}
          >
            {t('settings.save')}
          </Button>
        </form>
      </SettingsRow>
      {actions.save.isError ? <Notice variant="destructive">{actions.save.error.message}</Notice> : null}
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
      {factories.isError ? <Notice variant="destructive">{factories.error.message}</Notice> : null}
      {actions.startAccess.isError ? <Notice variant="destructive">{actions.startAccess.error.message}</Notice> : null}
      <SettingsRow label={t('settings.clear')} description={t('settings.clearDescription')}>
        <AlertDialog>
          <AlertDialog.Trigger render={<Button size="sm" variant="destructive-ghost" disabled={actions.clear.isPending}>{t('settings.clear')}</Button>} />
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
