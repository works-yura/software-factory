import { Badge } from '@mastra/playground-ui/components/Badge';
import { Button } from '@mastra/playground-ui/components/Button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@mastra/playground-ui/components/Dialog';
import { Input } from '@mastra/playground-ui/components/Input';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@mastra/playground-ui/components/Select';
import { Switch } from '@mastra/playground-ui/components/Switch';
import { Textarea } from '@mastra/playground-ui/components/Textarea';
import { toast } from '@mastra/playground-ui/components/Toaster';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { SettingsContainer, SettingsRow } from '@mastra/playground-ui/new/settings';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useFactoriesQuery } from '../../../../hooks/useFactories';
import {
  useFirebaseConnectionMutations,
  useFirebaseMappingMutations,
  useFirebaseMappingsQuery,
  useFirebaseStatusQuery,
} from '../../../../hooks/useFirebase';
import type { FirebaseApp, FirebaseCheckResult, FirebaseMapping, FirebasePlatform } from '../services/firebase';
import { SettingsSubsection } from './SettingsSubsection';
import { SourceItemCard } from './SourceItemCard';

const PLATFORMS: FirebasePlatform[] = ['android', 'ios', 'web'];

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

const emptyMapping = (): FirebaseMapping => ({ projectId: '', logs: true, crashes: true, apps: [] });

/** Paste or pick the service account key; the key is sent once and never shown again. */
function FirebaseKeyDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('settings');
  const { upload } = useFirebaseConnectionMutations();
  const [keyJson, setKeyJson] = useState('');

  const save = () =>
    upload.mutate(keyJson, {
      onSuccess: () => {
        toast.success(t('observability.connection.saved'));
        onClose();
      },
      onError: error => toast.error(errorMessage(error)),
    });

  return (
    <Dialog open onOpenChange={open => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('observability.connection.dialogTitle')}</DialogTitle>
          <DialogDescription>{t('observability.connection.roles')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          <Textarea
            aria-label={t('observability.connection.keyLabel')}
            placeholder={t('observability.connection.keyPlaceholder')}
            value={keyJson}
            rows={6}
            spellCheck={false}
            autoComplete="off"
            onChange={event => setKeyJson(event.target.value)}
          />
          <label className="cursor-pointer self-start">
            <input
              type="file"
              accept="application/json,.json"
              className="sr-only"
              aria-label={t('observability.connection.pickFile')}
              onChange={async event => {
                const file = event.target.files?.[0];
                if (file) setKeyJson(await file.text());
              }}
            />
            <Txt as="span" variant="caption" tone="muted" className="underline">
              {t('observability.connection.pickFile')}
            </Txt>
          </label>
        </DialogBody>
        <DialogFooter>
          <Button size="sm" variant="ghost" onClick={onClose}>
            {t('observability.cancel')}
          </Button>
          <Button size="sm" disabled={!keyJson.trim() || upload.isPending} onClick={save}>
            {t('observability.connection.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

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

/** What a Factory's project row says when collapsed: the project and what is read from it. */
function useMappingSummary() {
  const { t } = useTranslation('settings');
  return (mapping: FirebaseMapping | undefined) => {
    if (!mapping) return t('observability.project.notSaved');
    const parts = [t('observability.project.projectValue', { project: mapping.projectId })];
    if (mapping.logs) parts.push(t('observability.project.logsOn'));
    if (mapping.crashes !== false && mapping.apps.length > 0)
      parts.push(t('observability.project.apps', { count: mapping.apps.length }));
    if (parts.length === 1) parts.push(t('observability.project.nothingRead'));
    return parts.join(' · ');
  };
}

/** One Factory's Firebase project: which project, what its agents read, the apps, and a check that they can. */
function FirebaseProjectCard({
  factory,
  stored,
  connected,
  defaultOpen,
  onRemoved,
}: {
  factory: { id: string; name: string };
  stored: FirebaseMapping | undefined;
  connected: boolean;
  defaultOpen: boolean;
  onRemoved: () => void;
}) {
  const { t } = useTranslation('settings');
  const { save, check } = useFirebaseMappingMutations(factory.id);
  const summary = useMappingSummary();
  const [open, setOpen] = useState(defaultOpen);
  const [draft, setDraft] = useState<FirebaseMapping>(() => stored ?? emptyMapping());
  const [result, setResult] = useState<FirebaseCheckResult | null>(null);

  useEffect(() => {
    if (stored) setDraft(stored);
  }, [stored]);

  const update = (next: Partial<FirebaseMapping>) => {
    setResult(null);
    setDraft(current => ({ ...current, ...next }));
  };
  const updateApp = (index: number, next: Partial<FirebaseApp>) =>
    update({ apps: draft.apps.map((app, at) => (at === index ? { ...app, ...next } : app)) });
  const crashes = draft.crashes !== false;
  const payload = (): FirebaseMapping => ({
    projectId: draft.projectId.trim(),
    ...(draft.projectNumber?.trim() ? { projectNumber: draft.projectNumber.trim() } : {}),
    logs: draft.logs,
    crashes,
    apps: draft.apps.map(app => ({
      appId: app.appId.trim(),
      platform: app.platform,
      ...(app.label?.trim() ? { label: app.label.trim() } : {}),
    })),
  });

  return (
    <SourceItemCard title={factory.name} summary={summary(stored)} open={open} onOpenChange={setOpen}>
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
        <SettingsRow label={t('observability.mapping.crashes')} description={t('observability.mapping.crashesHint')}>
          <Switch
            aria-label={t('observability.mapping.crashes')}
            checked={crashes}
            onCheckedChange={next => update({ crashes: next })}
          />
        </SettingsRow>
      </SettingsContainer>

      {crashes && (
        <section aria-label={t('observability.mapping.apps')} className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <Txt as="h4" variant="meta" tone="muted">
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
        </section>
      )}

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
          onClick={() => check.mutate(payload(), { onSuccess: setResult, onError: error => toast.error(errorMessage(error)) })}
        >
          {check.isPending ? t('observability.check.running') : t('observability.check.run')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto"
          aria-label={t('observability.project.unlinkAria', { name: factory.name })}
          disabled={save.isPending}
          onClick={() =>
            stored
              ? save.mutate(null, { onSuccess: onRemoved, onError: error => toast.error(errorMessage(error)) })
              : onRemoved()
          }
        >
          {t('observability.project.unlink')}
        </Button>
      </div>
      {!connected && (
        <Txt as="p" variant="caption" tone="muted">
          {t('observability.check.needsKey')}
        </Txt>
      )}
      {result && <CheckResult result={result} />}
    </SourceItemCard>
  );
}

/**
 * Firebase as a source of logs and crashes, shaped like an intake source: who it is connected as,
 * the key, and the Factories linked to a Firebase project, each a card with what its agents read.
 */
function FirebaseSource() {
  const { t } = useTranslation('settings');
  const status = useFirebaseStatusQuery();
  const mappings = useFirebaseMappingsQuery();
  const factoriesQuery = useFactoriesQuery();
  const { disconnect } = useFirebaseConnectionMutations();
  const [keyDialog, setKeyDialog] = useState(false);
  const [adding, setAdding] = useState(false);
  const [drafts, setDrafts] = useState<string[]>([]);
  const account = status.data?.account;
  const connected = status.data?.connected === true;
  const factories = factoriesQuery.data ?? [];
  const stored = mappings.data ?? {};
  const linkedIds = [...Object.keys(stored), ...drafts.filter(id => !(id in stored))];
  const linked = linkedIds.flatMap(id => factories.filter(factory => factory.id === id));
  const unlinked = factories.filter(factory => !linkedIds.includes(factory.id));

  const description = status.isPending
    ? t('observability.source.checking')
    : status.isError
      ? errorMessage(status.error)
      : connected
        ? t('observability.source.ready')
        : t('observability.source.notConnected');
  const action = connected && account ? (
    <Txt tone="muted" as="span" variant="caption">
      {t('intake.connectedTo', { name: account.clientEmail })}
    </Txt>
  ) : status.isError ? (
    <Button size="sm" variant="ghost" onClick={() => void status.refetch()}>
      {t('intake.retry')}
    </Button>
  ) : !status.isPending ? (
    <Button size="sm" onClick={() => setKeyDialog(true)}>
      {t('observability.source.connect')}
    </Button>
  ) : undefined;

  const addFactory = (factoryId: string) => {
    setAdding(false);
    setDrafts(current => [...current, factoryId]);
  };

  return (
    <SettingsSubsection scope="org" title={t('observability.source.firebase')} description={description} action={action}>
      {connected && account && (
        <SettingsContainer>
          <SettingsRow
            label={t('observability.connection.account')}
            description={t('observability.connection.accountValue', { email: account.clientEmail, project: account.projectId })}
          >
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={() => setKeyDialog(true)}>
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
          </SettingsRow>
        </SettingsContainer>
      )}

      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <Txt as="h3" variant="body" tone="ink">
            {t('observability.project.linked')}
          </Txt>
          {adding ? (
            <Select open onOpenChange={open => !open && setAdding(false)} onValueChange={addFactory}>
              <SelectTrigger size="sm" aria-label={t('observability.project.pickFactory')} className="w-auto">
                <Txt as="span" variant="caption">
                  {t('observability.project.pickFactory')}
                </Txt>
              </SelectTrigger>
              <SelectContent>
                {unlinked.map(factory => (
                  <SelectItem key={factory.id} value={factory.id}>
                    {factory.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Button size="sm" disabled={unlinked.length === 0} onClick={() => setAdding(true)}>
              {t('observability.project.add')}
            </Button>
          )}
        </div>
        {mappings.isError ? (
          <Txt tone="muted" as="p" variant="caption">
            {errorMessage(mappings.error)}
          </Txt>
        ) : linked.length === 0 ? (
          <Txt tone="muted" as="p" variant="caption">
            {t('observability.project.none')}
          </Txt>
        ) : (
          linked.map(factory => (
            <FirebaseProjectCard
              key={factory.id}
              factory={factory}
              stored={stored[factory.id]}
              connected={connected}
              defaultOpen={drafts.includes(factory.id)}
              onRemoved={() => setDrafts(current => current.filter(id => id !== factory.id))}
            />
          ))
        )}
      </div>

      {keyDialog && <FirebaseKeyDialog onClose={() => setKeyDialog(false)} />}
    </SettingsSubsection>
  );
}

/**
 * Settings › Logs and crashes: the sources agents read logs and crashes from, each shaped like an
 * intake source. Firebase is the only one today; another provider (Sentry) is one more block here.
 */
export function ObservabilitySection() {
  return (
    <div className="flex flex-col gap-8">
      <FirebaseSource />
    </div>
  );
}
