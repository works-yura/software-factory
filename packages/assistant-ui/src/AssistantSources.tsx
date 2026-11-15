import { AlertDialog } from '@mastra/playground-ui/components/AlertDialog';
import { Button } from '@mastra/playground-ui/components/Button';
import { EmptyState } from '@mastra/playground-ui/components/EmptyState';
import { Input } from '@mastra/playground-ui/components/Input';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@mastra/playground-ui/components/Select';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { SettingsContainer, SettingsRow } from '@mastra/playground-ui/new/settings';
import { MessagesSquare } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { ChannelMode, ClickUpConnection, SourceChannel } from './sources-api';
import { CHANNEL_MODES, useAssistantSources, useSourceActions } from './sources-api';

function when(iso: string | null, never: string): string {
  return iso ? new Date(iso).toLocaleString() : never;
}

/**
 * The organization's ClickUp connection, when its token is this person's own ClickUp account (the
 * server proves it): read with it instead of pasting a second token.
 */
function OrgConnectionRow({ offer }: { offer: NonNullable<ClickUpConnection['orgOffer']> }) {
  const { t } = useTranslation('assistant');
  const actions = useSourceActions();
  return (
    <SettingsRow label={t('sources.orgTitle')} description={t('sources.orgHelp', { workspaces: offer.workspaces.join(', ') })}>
      <Button size="sm" variant="primary" disabled={actions.connectOrg.isPending} onClick={() => actions.connectOrg.mutate()}>
        {t('sources.useOrg', { name: offer.accountName })}
      </Button>
      {actions.connectOrg.isError ? <Notice variant="destructive">{actions.connectOrg.error.message}</Notice> : null}
    </SettingsRow>
  );
}

/** Connecting: the person's own personal API token, once; it never comes back from the server. */
function ConnectRow() {
  const { t } = useTranslation('assistant');
  const actions = useSourceActions();
  const [token, setToken] = useState('');
  return (
    <SettingsRow label={t('sources.clickup')} description={t('sources.tokenHelp')} controlPlacement="below">
      <form
        aria-label={t('sources.connectForm')}
        className="flex flex-wrap items-center gap-2"
        onSubmit={event => {
          event.preventDefault();
          if (token.trim()) actions.connect.mutate(token.trim(), { onSuccess: () => setToken('') });
        }}
      >
        <Input
          aria-label={t('sources.token')}
          type="password"
          autoComplete="off"
          placeholder="pk_…"
          className="min-w-0 flex-1"
          value={token}
          onChange={event => setToken(event.target.value)}
        />
        <Button type="submit" size="sm" disabled={!token.trim() || actions.connect.isPending}>
          {t('sources.connect')}
        </Button>
      </form>
      {actions.connect.isError ? <Notice variant="destructive">{actions.connect.error.message}</Notice> : null}
    </SettingsRow>
  );
}

function ChannelRow({ channel }: { channel: SourceChannel }) {
  const { t } = useTranslation('assistant');
  const actions = useSourceActions();
  const label = channel.kind === 'channel' ? `#${channel.name}` : channel.name;
  return (
    <SettingsRow
      label={label}
      description={
        <>
          <span>{t(`sources.kind.${channel.kind}`)}</span>
          {channel.mode !== 'ignore' ? <span>{t('sources.lastSync', { when: when(channel.lastSyncAt, t('sources.never')) })}</span> : null}
          {channel.lastError ? <span className="text-destructive-foreground">{channel.lastError}</span> : null}
        </>
      }
    >
      <Select
        value={channel.mode}
        disabled={actions.setMode.isPending}
        onValueChange={value =>
          actions.setMode.mutate({ workspaceId: channel.workspaceId, channelId: channel.channelId, mode: value as ChannelMode })
        }
      >
        <SelectTrigger size="sm" aria-label={t('sources.modeFor', { channel: label })}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {CHANNEL_MODES.map(mode => (
            <SelectItem key={mode} value={mode}>
              {t(`sources.mode.${mode}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </SettingsRow>
  );
}

function Connected({ connection }: { connection: ClickUpConnection }) {
  const { t } = useTranslation('assistant');
  const actions = useSourceActions();
  return (
    <>
      <SettingsContainer>
        <SettingsRow
          label={t('sources.clickup')}
          description={
            <>
              <span data-testid="clickup-account">{t('sources.connectedAs', { name: connection.account?.name ?? '' })}</span>
              {connection.via === 'org' ? <span>{t('sources.viaOrg')}</span> : null}
              <span>{t('sources.lastSync', { when: when(connection.lastSyncAt, t('sources.never')) })}</span>
            </>
          }
        >
          <Button size="sm" disabled={actions.sync.isPending || connection.status !== 'active'} onClick={() => actions.sync.mutate()}>
            {t('sources.syncNow')}
          </Button>
          <AlertDialog>
            <AlertDialog.Trigger
              render={
                <Button size="sm" variant="ghost" disabled={actions.disconnect.isPending}>
                  {t('sources.disconnect')}
                </Button>
              }
            />
            <AlertDialog.Content>
              <AlertDialog.Header>
                <AlertDialog.Title>{t('sources.disconnectTitle')}</AlertDialog.Title>
                <AlertDialog.Description>{t('sources.disconnectDescription')}</AlertDialog.Description>
              </AlertDialog.Header>
              <AlertDialog.Footer>
                <AlertDialog.Cancel>{t('actions.cancel')}</AlertDialog.Cancel>
                <AlertDialog.Action onClick={() => actions.disconnect.mutate()}>{t('sources.disconnect')}</AlertDialog.Action>
              </AlertDialog.Footer>
            </AlertDialog.Content>
          </AlertDialog>
        </SettingsRow>
      </SettingsContainer>
      {connection.status === 'rejected' ? (
        <Notice variant="destructive">{connection.via === 'org' ? t('sources.orgGone') : t('sources.rejected')}</Notice>
      ) : connection.lastError ? (
        <Notice variant="warning">{t('sources.syncFailed', { error: connection.lastError })}</Notice>
      ) : null}
      {actions.sync.isError ? <Notice variant="destructive">{actions.sync.error.message}</Notice> : null}
      {actions.setMode.isError ? <Notice variant="destructive">{actions.setMode.error.message}</Notice> : null}
      {connection.status === 'rejected' ? (
        <SettingsContainer>
          {connection.orgOffer ? <OrgConnectionRow offer={connection.orgOffer} /> : null}
          <ConnectRow />
        </SettingsContainer>
      ) : null}
      <Txt as="p" variant="caption" tone="muted" className="ps-2.5">
        {t('sources.modesHelp')}
      </Txt>
      {connection.channels.length === 0 ? (
        <EmptyState iconSlot={<MessagesSquare />} titleSlot={t('sources.noChannels')} descriptionSlot={t('sources.noChannelsHint')} />
      ) : (
        <SettingsContainer role="group" aria-label={t('sources.channels')}>
          {connection.channels.map(channel => (
            <ChannelRow key={`${channel.workspaceId}:${channel.channelId}`} channel={channel} />
          ))}
        </SettingsContainer>
      )}
    </>
  );
}

/**
 * Account › «Помічник» › «Джерела» (ADR-0051 phase 2): ClickUp Chat connected with the person's own
 * personal API token, a mode per channel (ignore / only when addressed / watch), and how the last
 * sync went. The assistant only reads: it never writes to ClickUp in this phase.
 */
export function AssistantSources() {
  const { t } = useTranslation('assistant');
  const sources = useAssistantSources();
  if (sources.isError) return <Notice variant="destructive">{sources.error.message}</Notice>;
  if (!sources.data) {
    return (
      <Txt as="p" variant="caption" tone="muted">
        {t('sources.loading')}
      </Txt>
    );
  }
  if (!sources.data.connected) {
    return (
      <SettingsContainer>
        {sources.data.orgOffer ? <OrgConnectionRow offer={sources.data.orgOffer} /> : null}
        <ConnectRow />
      </SettingsContainer>
    );
  }
  return <Connected connection={sources.data} />;
}
