import { Button } from '@mastra/playground-ui/components/Button';
import { Input } from '@mastra/playground-ui/components/Input';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@mastra/playground-ui/components/Select';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { SettingsContainer, SettingsEmptyRow, SettingsItem, SettingsListHeader, SettingsRow } from '@mastra/playground-ui/new/settings';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useQuery } from '@tanstack/react-query';

import { assistantKeys, call, useAssistantApi, useAssistantFactories, useAssistantSettings, useSettingsActions } from './api';
import type { DigestFrequency, DigestSettings } from './api';
import { RequestTime } from './time';
import { useAssistantSources, useSourceActions } from './sources-api';
import type { SourceChannel } from './sources-api';

const FREQUENCIES: readonly DigestFrequency[] = ['off', 'hourly', 'daily'];
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function ChannelRuleSelect({ channel, factories }: { channel: SourceChannel; factories: Array<{ id: string; name: string }> }) {
  const { t } = useTranslation('assistant');
  const actions = useSourceActions();
  const rule = channel.rule ?? 'analyse';
  // A rule naming a Factory the person no longer reaches still shows what it is.
  const askedId = rule.startsWith('analyse_and_ask:') ? rule.slice('analyse_and_ask:'.length) : null;
  const options = [
    { value: 'analyse', label: t('rules.analyse') },
    { value: 'digest_only', label: t('rules.digest_only') },
    ...factories.map(factory => ({ value: `analyse_and_ask:${factory.id}`, label: t('rules.analyse_and_ask', { factory: factory.name }) })),
    ...(askedId && !factories.some(factory => factory.id === askedId) ? [{ value: rule, label: t('rules.analyse_and_ask', { factory: askedId }) }] : []),
  ];
  return (
    <Select
      value={rule}
      disabled={actions.setRule.isPending}
      onValueChange={value => actions.setRule.mutate({ workspaceId: channel.workspaceId, channelId: channel.channelId, rule: value as string })}
    >
      <SelectTrigger size="sm" aria-label={t('rules.for', { channel: channel.name })}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map(option => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** The rules of the chats the person turned on: what the assistant does with a new request from each. */
function ChannelRules() {
  const { t } = useTranslation('assistant');
  const sources = useAssistantSources();
  const factories = useAssistantFactories();
  const actions = useSourceActions();
  const channels = sources.data?.channels.filter(channel => channel.mode !== 'ignore') ?? [];
  const reachable = factories.data?.connected ? factories.data.factories : [];
  return (
    <SettingsContainer aria-label={t('rules.title')}>
      {channels.length === 0 ? (
        <SettingsEmptyRow>{sources.data?.connected ? t('rules.noChannels') : t('rules.noSource')}</SettingsEmptyRow>
      ) : (
        <>
          <SettingsListHeader>{t('rules.count', { count: channels.length })}</SettingsListHeader>
          {channels.map(channel => (
            <SettingsItem key={`${channel.workspaceId}:${channel.channelId}`} title={channel.name} description={t(`sources.mode.${channel.mode}`)}>
              <ChannelRuleSelect channel={channel} factories={reachable} />
            </SettingsItem>
          ))}
        </>
      )}
      {actions.setRule.isError ? <Notice variant="destructive">{actions.setRule.error.message}</Notice> : null}
      <Txt as="p" variant="caption" tone="muted" className="p-3">
        {t('rules.hint')}
      </Txt>
    </SettingsContainer>
  );
}

/** The digest: off, hourly, or daily at an hour of the person's time zone. */
function DigestRows() {
  const { t } = useTranslation('assistant');
  const settings = useAssistantSettings();
  const save = useSettingsActions().save;
  const stored = settings.data?.digest;
  const [draft, setDraft] = useState<DigestSettings | undefined>(undefined);
  useEffect(() => {
    if (stored) setDraft(stored.frequency === 'off' && stored.timeZone === 'UTC' ? { ...stored, timeZone: browserTimeZone() } : stored);
  }, [stored]);
  if (!draft) return null;
  const changed = JSON.stringify(draft) !== JSON.stringify(stored);
  return (
    <SettingsContainer>
      <SettingsRow label={t('digest.frequency')} description={t('digest.frequencyDescription')}>
        <Select value={draft.frequency} onValueChange={value => setDraft({ ...draft, frequency: value as DigestFrequency })}>
          <SelectTrigger size="sm" aria-label={t('digest.frequency')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FREQUENCIES.map(frequency => (
              <SelectItem key={frequency} value={frequency}>
                {t(`digest.${frequency}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingsRow>
      {draft.frequency === 'daily' ? (
        <SettingsRow label={t('digest.hour')} description={t('digest.hourDescription')}>
          <div className="flex items-center gap-2">
            <Select value={String(draft.hour)} onValueChange={value => setDraft({ ...draft, hour: Number(value) })}>
              <SelectTrigger size="sm" aria-label={t('digest.hour')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {HOURS.map(hour => (
                  <SelectItem key={hour} value={String(hour)}>
                    {`${String(hour).padStart(2, '0')}:00`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              aria-label={t('digest.timeZone')}
              className="w-44"
              value={draft.timeZone}
              onChange={event => setDraft({ ...draft, timeZone: event.target.value })}
            />
          </div>
        </SettingsRow>
      ) : null}
      <SettingsRow label={t('digest.save')} description={t('digest.saveDescription')}>
        <Button size="sm" variant="primary" disabled={!changed || save.isPending} onClick={() => save.mutate({ digest: draft })}>
          {t('settings.save')}
        </Button>
      </SettingsRow>
      {save.isError ? <Notice variant="destructive">{save.error.message}</Notice> : null}
    </SettingsContainer>
  );
}

/** When the next digest is due, if one is scheduled. */
function DigestSchedule() {
  const { t } = useTranslation('assistant');
  const schedule = useDigestSchedule();
  if (!schedule?.nextAt) return null;
  return (
    <Txt as="p" variant="caption" tone="muted">
      {t('digest.next')} <RequestTime value={schedule.nextAt} />
    </Txt>
  );
}

function useDigestSchedule() {
  const api = useAssistantApi();
  return useQuery({
    queryKey: [...assistantKeys.settings(), 'schedule'],
    queryFn: () => call<{ digestSchedule?: { lastAt: string | null; nextAt: string | null } }>(api, '/settings').then(body => body.digestSchedule ?? null),
  }).data;
}

/**
 * Settings › «Помічник» › Проактивність: what the assistant does by itself — the rule of each chat
 * the person turned on (analyse, ask a Factory on its own, digest only) and the digest schedule.
 */
export function AssistantProactivitySettings() {
  return (
    <>
      <ChannelRules />
      <DigestRows />
      <DigestSchedule />
    </>
  );
}
