import { Button } from '@mastra/playground-ui/components/Button';
import { Input } from '@mastra/playground-ui/components/Input';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@mastra/playground-ui/components/Select';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { SettingsContainer, SettingsRow } from '@mastra/playground-ui/new/settings';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useQuery } from '@tanstack/react-query';

import { assistantKeys, call, useAssistantApi, useAssistantSettings, useSettingsActions } from './api';
import type { DigestFrequency, DigestSettings } from './api';
import { RequestTime } from './time';

const FREQUENCIES: readonly DigestFrequency[] = ['off', 'hourly', 'daily'];
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
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
 * Settings › «Помічник» › Проактивність: what the assistant does by itself — only the digest of the
 * person's open requests on their schedule. It never reads a chat for it: requests come only from
 * the person (the panel's «+», or their tag in a chat). Per-chat rules were retired with the tag
 * (ADR-0051 amendment 2026-11-16).
 */
export function AssistantProactivitySettings() {
  return (
    <>
      <DigestRows />
      <DigestSchedule />
    </>
  );
}
