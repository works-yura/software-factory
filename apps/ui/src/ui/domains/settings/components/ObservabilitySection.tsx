import { Badge } from '@mastra/playground-ui/components/Badge';
import { Button } from '@mastra/playground-ui/components/Button';
import { Input } from '@mastra/playground-ui/components/Input';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@mastra/playground-ui/components/Select';
import { Switch } from '@mastra/playground-ui/components/Switch';
import { Textarea } from '@mastra/playground-ui/components/Textarea';
import { toast } from '@mastra/playground-ui/components/Toaster';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { SettingsContainer, SettingsRow } from '@mastra/playground-ui/new/settings';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  useFirebaseConnectionMutations,
  useFirebaseMappingMutations,
  useFirebaseMappingQuery,
  useFirebaseStatusQuery,
} from '../../../../hooks/useFirebase';
import type { FirebaseApp, FirebaseCheckResult, FirebaseMapping, FirebasePlatform } from '../services/firebase';
import { SettingsSubsection } from './SettingsSubsection';

const PLATFORMS: FirebasePlatform[] = ['android', 'ios', 'web'];

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The org's service account: who it is when connected, a place to paste or pick the key file when not. */
function FirebaseConnection() {
  const { t } = useTranslation('settings');
  const status = useFirebaseStatusQuery();
  const { upload, disconnect } = useFirebaseConnectionMutations();
  const [keyJson, setKeyJson] = useState('');
  const [replacing, setReplacing] = useState(false);
  const account = status.data?.account;
  const showForm = !account || replacing;

  const save = () =>
    upload.mutate(keyJson, {
      onSuccess: () => {
        setKeyJson('');
        setReplacing(false);
        toast.success(t('observability.connection.saved'));
      },
      onError: error => toast.error(errorMessage(error)),
    });

  const pickFile = async (file: File | undefined) => {
    if (file) setKeyJson(await file.text());
  };

  return (
    <SettingsSubsection
      scope="org"
      title={t('observability.connection.title')}
      description={t('observability.connection.description')}
      action={
        account && !replacing ? (
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={() => setReplacing(true)}>
              {t('observability.connection.replace')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={disconnect.isPending}
              onClick={() => disconnect.mutate(undefined, { onError: error => toast.error(errorMessage(error)) })}
            >
              {t('observability.connection.disconnect')}
            </Button>
          </div>
        ) : undefined
      }
    >
      {status.isError && (
        <Txt tone="muted" as="p" variant="caption">
          {errorMessage(status.error)}
        </Txt>
      )}
      {account && (
        <SettingsContainer>
          <SettingsRow label={t('observability.connection.account')}>
            <Txt as="span" variant="caption" tone="muted">
              {t('observability.connection.accountValue', { email: account.clientEmail, project: account.projectId })}
            </Txt>
          </SettingsRow>
        </SettingsContainer>
      )}
      {showForm && (
        <div className="flex flex-col gap-3">
          <Txt as="p" variant="caption" tone="muted">
            {t('observability.connection.roles')}
          </Txt>
          <Textarea
            aria-label={t('observability.connection.keyLabel')}
            placeholder={t('observability.connection.keyPlaceholder')}
            value={keyJson}
            rows={6}
            spellCheck={false}
            autoComplete="off"
            onChange={event => setKeyJson(event.target.value)}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={!keyJson.trim() || upload.isPending} onClick={save}>
              {t('observability.connection.save')}
            </Button>
            <label className="cursor-pointer">
              <input
                type="file"
                accept="application/json,.json"
                className="sr-only"
                aria-label={t('observability.connection.pickFile')}
                onChange={event => void pickFile(event.target.files?.[0])}
              />
              <Txt as="span" variant="caption" tone="muted" className="underline">
                {t('observability.connection.pickFile')}
              </Txt>
            </label>
            {replacing && (
              <Button size="sm" variant="ghost" onClick={() => setReplacing(false)}>
                {t('observability.cancel')}
              </Button>
            )}
          </div>
        </div>
      )}
    </SettingsSubsection>
  );
}

const emptyMapping = (): FirebaseMapping => ({ projectId: '', logs: true, apps: [] });

function CheckResult({ result }: { result: FirebaseCheckResult }) {
  const { t } = useTranslation('settings');
  return (
    <ul aria-label={t('observability.check.results')} className="flex flex-col gap-2">
      {result.checks.map(check => (
        <li key={`${check.check}:${check.target}`} className="flex flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <Badge size="sm" variant={check.ok ? 'success' : 'destructive'}>
              {check.ok ? t('observability.check.ok') : t('observability.check.failed')}
            </Badge>
            <Txt as="span" variant="caption">
              {t(`observability.check.${check.check}`, { target: check.target })}
            </Txt>
          </div>
          {!check.ok && (
            <Txt as="p" variant="caption" tone="muted">
              {check.missingRole ? t('observability.check.missingRole', { role: check.missingRole }) : check.message}
              {check.fix ? ` ${check.fix}` : ''}
            </Txt>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Which Firebase project and apps this Factory's agents read, and a check that they can. */
function FactoryMapping({ factoryId, connected }: { factoryId: string; connected: boolean }) {
  const { t } = useTranslation('settings');
  const stored = useFirebaseMappingQuery(factoryId);
  const { save, check } = useFirebaseMappingMutations(factoryId);
  const [draft, setDraft] = useState<FirebaseMapping>(emptyMapping);
  const [result, setResult] = useState<FirebaseCheckResult | null>(null);

  useEffect(() => {
    if (stored.data !== undefined) setDraft(stored.data ?? emptyMapping());
  }, [stored.data]);

  const update = (next: Partial<FirebaseMapping>) => {
    setResult(null);
    setDraft(current => ({ ...current, ...next }));
  };
  const updateApp = (index: number, next: Partial<FirebaseApp>) =>
    update({ apps: draft.apps.map((app, at) => (at === index ? { ...app, ...next } : app)) });
  const payload = (): FirebaseMapping => ({
    projectId: draft.projectId.trim(),
    ...(draft.projectNumber?.trim() ? { projectNumber: draft.projectNumber.trim() } : {}),
    logs: draft.logs,
    apps: draft.apps.map(app => ({
      appId: app.appId.trim(),
      platform: app.platform,
      ...(app.label?.trim() ? { label: app.label.trim() } : {}),
    })),
  });

  return (
    <SettingsSubsection scope="factory" title={t('observability.mapping.title')} description={t('observability.mapping.description')}>
      <SettingsContainer>
        <SettingsRow label={t('observability.mapping.projectId')} description={t('observability.mapping.projectIdHint')}>
          <Input
            aria-label={t('observability.mapping.projectId')}
            value={draft.projectId}
            placeholder="syncta-prod"
            onChange={event => update({ projectId: event.target.value })}
          />
        </SettingsRow>
        <SettingsRow label={t('observability.mapping.projectNumber')} description={t('observability.mapping.projectNumberHint')}>
          <Input
            aria-label={t('observability.mapping.projectNumber')}
            value={draft.projectNumber ?? ''}
            placeholder="1234567890"
            onChange={event => update({ projectNumber: event.target.value })}
          />
        </SettingsRow>
        <SettingsRow label={t('observability.mapping.logs')} description={t('observability.mapping.logsHint')}>
          <Switch aria-label={t('observability.mapping.logs')} checked={draft.logs} onCheckedChange={logs => update({ logs })} />
        </SettingsRow>
      </SettingsContainer>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <Txt as="h3" variant="body" tone="ink">
            {t('observability.mapping.apps')}
          </Txt>
          <Button size="sm" variant="ghost" onClick={() => update({ apps: [...draft.apps, { appId: '', platform: 'android' }] })}>
            {t('observability.mapping.addApp')}
          </Button>
        </div>
        {draft.apps.length === 0 ? (
          <Txt as="p" variant="caption" tone="muted">
            {t('observability.mapping.noApps')}
          </Txt>
        ) : (
          draft.apps.map((app, index) => (
            <div key={index} className="flex flex-wrap items-center gap-2">
              <Input
                className="min-w-64 flex-1"
                aria-label={t('observability.mapping.appId', { number: index + 1 })}
                value={app.appId}
                placeholder="1:1234567890:android:0a1b2c3d4e5f"
                onChange={event => updateApp(index, { appId: event.target.value })}
              />
              <Select value={app.platform} onValueChange={platform => updateApp(index, { platform: platform as FirebasePlatform })}>
                <SelectTrigger aria-label={t('observability.mapping.platform', { number: index + 1 })} className="w-32">
                  {t(`observability.platforms.${app.platform}`)}
                </SelectTrigger>
                <SelectContent>
                  {PLATFORMS.map(platform => (
                    <SelectItem key={platform} value={platform}>
                      {t(`observability.platforms.${platform}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                className="w-48"
                aria-label={t('observability.mapping.appLabel', { number: index + 1 })}
                value={app.label ?? ''}
                placeholder={t('observability.mapping.appLabelPlaceholder')}
                onChange={event => updateApp(index, { label: event.target.value })}
              />
              <Button
                size="sm"
                variant="ghost"
                aria-label={t('observability.mapping.removeApp', { number: index + 1 })}
                onClick={() => update({ apps: draft.apps.filter((_, at) => at !== index) })}
              >
                {t('observability.mapping.remove')}
              </Button>
            </div>
          ))
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={!draft.projectId.trim() || save.isPending}
          onClick={() =>
            save.mutate(payload(), {
              onSuccess: () => toast.success(t('observability.mapping.saved')),
              onError: error => toast.error(errorMessage(error)),
            })
          }
        >
          {t('observability.mapping.save')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!connected || !draft.projectId.trim() || check.isPending}
          onClick={() =>
            check.mutate(payload(), { onSuccess: setResult, onError: error => toast.error(errorMessage(error)) })
          }
        >
          {check.isPending ? t('observability.check.running') : t('observability.check.run')}
        </Button>
        {stored.data && (
          <Button
            size="sm"
            variant="ghost"
            disabled={save.isPending}
            onClick={() => save.mutate(null, { onError: error => toast.error(errorMessage(error)) })}
          >
            {t('observability.mapping.turnOff')}
          </Button>
        )}
      </div>
      {!connected && (
        <Txt as="p" variant="caption" tone="muted">
          {t('observability.check.needsKey')}
        </Txt>
      )}
      {result && <CheckResult result={result} />}
    </SettingsSubsection>
  );
}

/**
 * Settings › Logs and crashes: the org's read-only Firebase service account, and per Factory the
 * project and apps its agents may read logs and crashes from.
 */
export function ObservabilitySection({ factoryId }: { factoryId: string }) {
  const status = useFirebaseStatusQuery();
  return (
    <>
      <FirebaseConnection />
      <FactoryMapping factoryId={factoryId} connected={status.data?.connected === true} />
    </>
  );
}
