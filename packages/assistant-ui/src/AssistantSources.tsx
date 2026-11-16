import { AlertDialog } from '@mastra/playground-ui/components/AlertDialog';
import { Button } from '@mastra/playground-ui/components/Button';
import { Input } from '@mastra/playground-ui/components/Input';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@mastra/playground-ui/components/Select';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { SettingsContainer, SettingsRow } from '@mastra/playground-ui/new/settings';
import { RotateCcw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { ClickUpConnection, TagWho } from './sources-api';
import { tagPatternError, tryTag, useAssistantSources, useSourceActions } from './sources-api';

const WHO: readonly TagWho[] = ['me', 'anyone'];

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

/**
 * The tag: the only thing in a chat that makes a request. Its pattern (a regular expression, checked
 * here and on the server, with a live tester), who may tag, and how many earlier messages of a flat
 * chat come along as context.
 */
function TagRows({ connection }: { connection: ClickUpConnection }) {
  const { t } = useTranslation('assistant');
  const setTag = useSourceActions().setTag;
  const tag = connection.tag;
  const current = tag.pattern ?? tag.defaultPattern;
  const [pattern, setPattern] = useState(current);
  const [sample, setSample] = useState(() => t('sources.tag.sample'));
  const [context, setContext] = useState(String(tag.contextMessages));
  useEffect(() => setPattern(current), [current]);
  useEffect(() => setContext(String(tag.contextMessages)), [tag.contextMessages]);
  const problem = tagPatternError(pattern);
  const tried = tryTag(pattern, sample);
  const contextValue = Number(context);
  const contextValid = context.trim() !== '' && Number.isInteger(contextValue) && contextValue >= 0 && contextValue <= 50;
  return (
    <SettingsContainer aria-label={t('sources.tag.title')}>
      <SettingsRow label={t('sources.tag.title')} description={t('sources.tag.help')} controlPlacement="below">
        <form
          aria-label={t('sources.tag.form')}
          className="flex flex-wrap items-center gap-2"
          onSubmit={event => {
            event.preventDefault();
            if (!problem && pattern !== current) setTag.mutate({ pattern: pattern === tag.defaultPattern ? null : pattern });
          }}
        >
          <Input
            aria-label={t('sources.tag.pattern')}
            aria-invalid={problem ? true : undefined}
            autoComplete="off"
            spellCheck={false}
            className="min-w-0 flex-1 font-mono"
            value={pattern}
            onChange={event => setPattern(event.target.value)}
          />
          <Button type="submit" size="sm" aria-label={t('sources.tag.save')} disabled={Boolean(problem) || pattern === current || setTag.isPending}>
            {t('settings.save')}
          </Button>
          {tag.pattern !== null ? (
            <Button size="sm" variant="ghost" icon={<RotateCcw />} disabled={setTag.isPending} onClick={() => setTag.mutate({ pattern: null })}>
              {t('sources.tag.useDefault')}
            </Button>
          ) : null}
        </form>
        {problem ? (
          <Txt as="p" variant="caption" role="alert">
            {t(`sources.tag.problem.${problem}`)}
          </Txt>
        ) : null}
      </SettingsRow>
      <SettingsRow label={t('sources.tag.test')} description={t('sources.tag.testHelp')} controlPlacement="below">
        <Input aria-label={t('sources.tag.testInput')} className="min-w-0" value={sample} onChange={event => setSample(event.target.value)} />
        <Txt as="p" variant="caption" tone="muted" data-testid="tag-test-result" aria-live="polite">
          {!tried
            ? t('sources.tag.testInvalid')
            : tried.matches
              ? t('sources.tag.testMatch', { instruction: tried.instruction || t('sources.tag.noInstruction') })
              : t('sources.tag.testNoMatch')}
        </Txt>
      </SettingsRow>
      <SettingsRow label={t('sources.tag.who')} description={t('sources.tag.whoHelp')}>
        <Select value={tag.who} disabled={setTag.isPending} onValueChange={value => setTag.mutate({ who: value as TagWho })}>
          <SelectTrigger size="sm" aria-label={t('sources.tag.who')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {WHO.map(who => (
              <SelectItem key={who} value={who}>
                {t(`sources.tag.whoOption.${who}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingsRow>
      <SettingsRow label={t('sources.tag.context')} description={t('sources.tag.contextHelp')}>
        <form
          className="flex items-center gap-2"
          onSubmit={event => {
            event.preventDefault();
            if (contextValid && contextValue !== tag.contextMessages) setTag.mutate({ contextMessages: contextValue });
          }}
        >
          <Input
            aria-label={t('sources.tag.context')}
            type="number"
            min={0}
            max={50}
            className="w-20"
            value={context}
            onChange={event => setContext(event.target.value)}
          />
          <Button
            type="submit"
            size="sm"
            aria-label={t('sources.tag.saveContext')}
            disabled={!contextValid || contextValue === tag.contextMessages || setTag.isPending}
          >
            {t('settings.save')}
          </Button>
        </form>
      </SettingsRow>
      {setTag.isError ? <Notice variant="destructive">{setTag.error.message}</Notice> : null}
    </SettingsContainer>
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
              <span>{t('sources.chats', { count: connection.chats.total })}</span>
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
      {connection.status === 'rejected' ? (
        <SettingsContainer>
          {connection.orgOffer ? <OrgConnectionRow offer={connection.orgOffer} /> : null}
          <ConnectRow />
        </SettingsContainer>
      ) : null}
      <TagRows connection={connection} />
    </>
  );
}

/**
 * Settings › «Помічник» › «Джерела» (ADR-0051 phase 2; the tag per the amendment of 2026-11-16):
 * ClickUp Chat connected with the person's own personal API token (or the organization's connection
 * when it is their account), their tag — the only thing that makes a request from a chat — and how
 * the last read went. There is no per-chat choice. The assistant only reads: it never writes to ClickUp.
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
