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
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { useFactoriesQuery } from '../../../../hooks/useFactories';
import {
  useFirebaseDatabases,
  useFirebaseMutations,
  useFirebaseProjects,
  useFirebaseStateQuery,
} from '../../../../hooks/useFirebase';
import type {
  FirebaseAccount,
  FirebaseApp,
  FirebaseBinding,
  FirebaseBindingInput,
  FirebaseCheckResult,
  FirebasePlatform,
} from '../services/firebase';
import { DiscoveredChoice } from './DiscoveredChoice';
import { SourceItemCard } from './SourceItemCard';

const PLATFORMS: FirebasePlatform[] = ['android', 'ios', 'web'];

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

type Factory = { id: string; name: string };

/** A list heading with its add button, as «Підключені Lists» in task intake. */
function ListHeader({ title, action }: { title: string; action: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <Txt as="h3" variant="body" tone="ink">
        {title}
      </Txt>
      {action}
    </div>
  );
}

/**
 * Paste or pick a service account key: a new account, or a new key for `account`. Sent once, never
 * shown again. The one dialog for adding a Google Cloud account, also from an MCP server's form.
 */
export function AccountKeyDialog({
  account,
  onClose,
  onAdded,
}: {
  account?: FirebaseAccount;
  onClose: () => void;
  /** The new account, so a form that asked for it can pick it. */
  onAdded?: (account: FirebaseAccount) => void;
}) {
  const { t } = useTranslation('settings');
  const { addAccount, updateAccount } = useFirebaseMutations();
  const [keyJson, setKeyJson] = useState('');
  const [name, setName] = useState('');
  const pending = addAccount.isPending || updateAccount.isPending;

  const done = {
    onSuccess: () => {
      toast.success(t('observability.accounts.saved'));
      onClose();
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  };
  const save = () =>
    account
      ? updateAccount.mutate({ accountId: account.id, serviceAccountJson: keyJson }, done)
      : addAccount.mutate(
          { serviceAccountJson: keyJson, ...(name.trim() ? { name: name.trim() } : {}) },
          {
            ...done,
            onSuccess: result => {
              onAdded?.(result.account);
              done.onSuccess();
            },
          },
        );

  return (
    <Dialog open onOpenChange={open => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {account ? t('observability.key.replaceTitle', { name: account.name }) : t('observability.key.addTitle')}
          </DialogTitle>
          <DialogDescription>{t('observability.key.roles')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          {!account && (
            <Input
              aria-label={t('observability.key.nameLabel')}
              placeholder={t('observability.key.namePlaceholder')}
              value={name}
              onChange={event => setName(event.target.value)}
            />
          )}
          <Textarea
            aria-label={t('observability.key.keyLabel')}
            placeholder={t('observability.key.keyPlaceholder')}
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
              aria-label={t('observability.key.pickFile')}
              onChange={async event => {
                const file = event.target.files?.[0];
                if (file) setKeyJson(await file.text());
              }}
            />
            <Txt as="span" variant="caption" tone="muted" className="underline">
              {t('observability.key.pickFile')}
            </Txt>
          </label>
        </DialogBody>
        <DialogFooter>
          <Button size="sm" variant="ghost" onClick={onClose}>
            {t('observability.cancel')}
          </Button>
          <Button size="sm" disabled={!keyJson.trim() || pending} onClick={save}>
            {t('observability.key.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Confirms removing an account its bindings read through: the bindings go with it. */
export function RemoveAccountDialog({
  account,
  bindings,
  factoryName,
  onClose,
}: {
  account: FirebaseAccount;
  bindings: FirebaseBinding[];
  factoryName: (id: string) => string;
  onClose: () => void;
}) {
  const { t } = useTranslation('settings');
  const { removeAccount } = useFirebaseMutations();
  return (
    <Dialog open onOpenChange={open => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('observability.accounts.confirmTitle', { name: account.name })}</DialogTitle>
          <DialogDescription>{t('observability.accounts.confirmBody')}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <ul aria-label={t('observability.accounts.confirmList')} className="flex flex-col gap-1">
            {bindings.map(binding => (
              <li key={binding.id}>
                <Txt as="span" variant="caption">
                  {t('observability.bindings.title', { factory: factoryName(binding.factoryProjectId), project: binding.projectId })}
                </Txt>
              </li>
            ))}
          </ul>
        </DialogBody>
        <DialogFooter>
          <Button size="sm" variant="ghost" onClick={onClose}>
            {t('observability.cancel')}
          </Button>
          <Button
            size="sm"
            disabled={removeAccount.isPending}
            onClick={() =>
              removeAccount.mutate(
                { accountId: account.id, withBindings: true },
                {
                  onSuccess: () => {
                    toast.success(t('observability.accounts.removed'));
                    onClose();
                  },
                  onError: error => toast.error(errorMessage(error)),
                },
              )
            }
          >
            {t('observability.accounts.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One Google Cloud account: its name, whose key it is, the bindings that use it, key and removal. */
export function AccountCard({
  account,
  bindings,
  factoryName,
}: {
  account: FirebaseAccount;
  bindings: FirebaseBinding[];
  factoryName: (id: string) => string;
}) {
  const { t } = useTranslation('settings');
  const { updateAccount, removeAccount } = useFirebaseMutations();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(account.name);
  const [keyDialog, setKeyDialog] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const used = bindings.filter(binding => account.bindingIds.includes(binding.id));

  useEffect(() => setName(account.name), [account.name]);

  const summary = [
    account.clientEmail,
    used.length > 0 ? t('observability.accounts.usedBy', { count: used.length }) : t('observability.accounts.unused'),
  ].join(' · ');

  return (
    <SourceItemCard title={account.name} summary={summary} open={open} onOpenChange={setOpen}>
      <SettingsContainer>
        <SettingsRow label={t('observability.accounts.name')} description={t('observability.accounts.nameHint')}>
          <div className="flex gap-2">
            <Input aria-label={t('observability.accounts.name')} value={name} onChange={event => setName(event.target.value)} />
            <Button
              size="sm"
              variant="ghost"
              disabled={!name.trim() || name.trim() === account.name || updateAccount.isPending}
              onClick={() =>
                updateAccount.mutate(
                  { accountId: account.id, name: name.trim() },
                  { onSuccess: () => toast.success(t('observability.accounts.saved')), onError: error => toast.error(errorMessage(error)) },
                )
              }
            >
              {t('observability.accounts.rename')}
            </Button>
          </div>
        </SettingsRow>
        <SettingsRow
          label={t('observability.accounts.key')}
          description={t('observability.accounts.keyValue', { email: account.clientEmail, project: account.projectId })}
        >
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={() => setKeyDialog(true)}>
              {t('observability.accounts.replace')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-label={t('observability.accounts.disconnectAria', { name: account.name })}
              disabled={removeAccount.isPending}
              onClick={() =>
                used.length > 0
                  ? setConfirm(true)
                  : removeAccount.mutate(
                      { accountId: account.id, withBindings: false },
                      { onSuccess: () => toast.success(t('observability.accounts.removed')), onError: error => toast.error(errorMessage(error)) },
                    )
              }
            >
              {t('observability.accounts.disconnect')}
            </Button>
          </div>
        </SettingsRow>
        <SettingsRow
          label={t('observability.accounts.usedIn')}
          description={
            used.length === 0
              ? t('observability.accounts.usedInNone')
              : used
                  .map(binding => t('observability.bindings.title', { factory: factoryName(binding.factoryProjectId), project: binding.projectId }))
                  .join('; ')
          }
        />
      </SettingsContainer>
      {keyDialog && <AccountKeyDialog account={account} onClose={() => setKeyDialog(false)} />}
      {confirm && <RemoveAccountDialog account={account} bindings={used} factoryName={factoryName} onClose={() => setConfirm(false)} />}
    </SourceItemCard>
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

export type BindingDraft = Omit<FirebaseBindingInput, 'projectNumber'> & { id?: string; projectNumber: string };

export const draftOf = (binding: FirebaseBinding): BindingDraft => ({ ...binding, projectNumber: binding.projectNumber ?? '' });

/** One binding: which Factory reads which Google Cloud project through which account, and a check that it can. */
export function BindingCard({
  stored,
  draft: initial,
  accounts,
  factories,
  onDone,
  defaultOpen,
}: {
  stored?: FirebaseBinding;
  draft: BindingDraft;
  accounts: FirebaseAccount[];
  factories: Factory[];
  /** A new binding was saved or dropped: the page removes its draft. */
  onDone?: () => void;
  /** Opened by default (a connection's own page shows its binding open). */
  defaultOpen?: boolean;
}) {
  const { t } = useTranslation('settings');
  const { saveBinding, removeBinding, checkBinding } = useFirebaseMutations();
  const [open, setOpen] = useState(stored === undefined || defaultOpen === true);
  const [draft, setDraft] = useState<BindingDraft>(initial);
  const [result, setResult] = useState<FirebaseCheckResult | null>(null);
  // What the chosen account can see: its projects, and the project's databases once «База» is on.
  const accountKnown = accounts.some(account => account.id === draft.accountId);
  const projects = useFirebaseProjects(open && accountKnown ? draft.accountId : undefined);
  const databases = useFirebaseDatabases(
    open && accountKnown && draft.database?.enabled ? draft.accountId : undefined,
    draft.projectId.trim() || undefined,
  );

  useEffect(() => {
    if (stored) setDraft(draftOf(stored));
  }, [stored]);

  const factoryName = (id: string) => factories.find(factory => factory.id === id)?.name ?? id;
  const accountName = (id: string) => accounts.find(account => account.id === id)?.name ?? t('observability.bindings.noAccount');
  const update = (next: Partial<BindingDraft>) => {
    setResult(null);
    setDraft(current => ({ ...current, ...next }));
  };
  const updateApp = (index: number, next: Partial<FirebaseApp>) =>
    update({ apps: draft.apps.map((app, at) => (at === index ? { ...app, ...next } : app)) });
  const payload = (): FirebaseBindingInput => ({
    factoryProjectId: draft.factoryProjectId,
    accountId: draft.accountId,
    projectId: draft.projectId.trim(),
    ...(draft.projectNumber.trim() ? { projectNumber: draft.projectNumber.trim() } : {}),
    logs: draft.logs,
    crashes: draft.crashes,
    ...(draft.database?.enabled
      ? { database: { enabled: true, ...(draft.database.databaseId?.trim() ? { databaseId: draft.database.databaseId.trim() } : {}) } }
      : draft.database
        ? { database: { enabled: false } }
        : {}),
    apps: draft.apps.map(app => ({
      appId: app.appId.trim(),
      platform: app.platform,
      ...(app.label?.trim() ? { label: app.label.trim() } : {}),
    })),
  });
  const ready = Boolean(draft.factoryProjectId && accounts.some(account => account.id === draft.accountId) && draft.projectId.trim());

  const title = stored
    ? t('observability.bindings.title', { factory: factoryName(stored.factoryProjectId), project: stored.projectId })
    : t('observability.bindings.newTitle');
  const summary = stored
    ? [
        accountName(stored.accountId),
        ...(stored.logs ? [t('observability.bindings.logsOn')] : []),
        ...(stored.crashes && stored.apps.length > 0 ? [t('observability.bindings.apps', { count: stored.apps.length })] : []),
        ...(stored.database?.enabled ? [t('observability.bindings.databaseOn')] : []),
        ...(!stored.logs && !(stored.crashes && stored.apps.length > 0) && !stored.database?.enabled
          ? [t('observability.bindings.nothingRead')]
          : []),
      ].join(' · ')
    : t('observability.bindings.notSaved');

  return (
    <SourceItemCard title={title} summary={summary} open={open} onOpenChange={setOpen}>
      <SettingsContainer>
        <SettingsRow label={t('observability.bindings.factory')} description={t('observability.bindings.factoryHint')}>
          <Select value={draft.factoryProjectId} onValueChange={factoryProjectId => update({ factoryProjectId })}>
            <SelectTrigger aria-label={t('observability.bindings.factory')} className="w-56">
              {draft.factoryProjectId ? factoryName(draft.factoryProjectId) : t('observability.bindings.pickFactory')}
            </SelectTrigger>
            <SelectContent>
              {factories.map(factory => (
                <SelectItem key={factory.id} value={factory.id}>
                  {factory.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>
        <SettingsRow label={t('observability.bindings.account')} description={t('observability.bindings.accountHint')}>
          <Select
            value={draft.accountId}
            onValueChange={accountId =>
              // The key's own project is the usual one: offer it, but keep a project already typed.
              update({ accountId, ...(draft.projectId.trim() ? {} : { projectId: accounts.find(account => account.id === accountId)?.projectId ?? '' }) })
            }
          >
            <SelectTrigger aria-label={t('observability.bindings.account')} className="w-56">
              {accounts.some(account => account.id === draft.accountId) ? accountName(draft.accountId) : t('observability.bindings.pickAccount')}
            </SelectTrigger>
            <SelectContent>
              {accounts.map(account => (
                <SelectItem key={account.id} value={account.id}>
                  {account.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>
        <SettingsRow label={t('observability.bindings.projectId')} description={t('observability.bindings.projectIdHint')}>
          <DiscoveredChoice
            label={t('observability.bindings.projectId')}
            value={draft.projectId}
            onChange={projectId => update({ projectId })}
            choices={projects.data}
            loading={projects.isFetching}
            placeholder="syncta-prod"
          />
        </SettingsRow>
        <SettingsRow label={t('observability.bindings.projectNumber')} description={t('observability.bindings.projectNumberHint')}>
          <Input
            aria-label={t('observability.bindings.projectNumber')}
            value={draft.projectNumber}
            placeholder="1234567890"
            onChange={event => update({ projectNumber: event.target.value })}
          />
        </SettingsRow>
        <SettingsRow label={t('observability.bindings.logs')} description={t('observability.bindings.logsHint')}>
          <Switch aria-label={t('observability.bindings.logs')} checked={draft.logs} onCheckedChange={logs => update({ logs })} />
        </SettingsRow>
        <SettingsRow label={t('observability.bindings.crashes')} description={t('observability.bindings.crashesHint')}>
          <Switch aria-label={t('observability.bindings.crashes')} checked={draft.crashes} onCheckedChange={crashes => update({ crashes })} />
        </SettingsRow>
        <SettingsRow label={t('observability.bindings.database')} description={t('observability.bindings.databaseHint')}>
          <Switch
            aria-label={t('observability.bindings.database')}
            checked={draft.database?.enabled === true}
            onCheckedChange={enabled => update({ database: { ...draft.database, enabled } })}
          />
        </SettingsRow>
        {draft.database?.enabled && (
          <SettingsRow label={t('observability.bindings.databaseId')} description={t('observability.bindings.databaseIdHint')}>
            <DiscoveredChoice
              label={t('observability.bindings.databaseId')}
              value={draft.database.databaseId ?? ''}
              onChange={databaseId => update({ database: { enabled: true, databaseId } })}
              choices={databases.data}
              loading={databases.isFetching}
              placeholder="(default)"
            />
          </SettingsRow>
        )}
      </SettingsContainer>

      {draft.crashes && (
        <section aria-label={t('observability.bindings.appsTitle')} className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <Txt as="h4" variant="meta" tone="muted">
              {t('observability.bindings.appsTitle')}
            </Txt>
            <Button size="sm" variant="ghost" onClick={() => update({ apps: [...draft.apps, { appId: '', platform: 'android' }] })}>
              {t('observability.bindings.addApp')}
            </Button>
          </div>
          {draft.apps.length === 0 ? (
            <Txt as="p" variant="caption" tone="muted">
              {t('observability.bindings.noApps')}
            </Txt>
          ) : (
            draft.apps.map((app, index) => (
              <div key={index} className="flex flex-wrap items-center gap-2">
                <Input
                  className="min-w-64 flex-1"
                  aria-label={t('observability.bindings.appId', { number: index + 1 })}
                  value={app.appId}
                  placeholder="1:1234567890:android:0a1b2c3d4e5f"
                  onChange={event => updateApp(index, { appId: event.target.value })}
                />
                <Select value={app.platform} onValueChange={platform => updateApp(index, { platform: platform as FirebasePlatform })}>
                  <SelectTrigger aria-label={t('observability.bindings.platform', { number: index + 1 })} className="w-32">
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
                  aria-label={t('observability.bindings.appLabel', { number: index + 1 })}
                  value={app.label ?? ''}
                  placeholder={t('observability.bindings.appLabelPlaceholder')}
                  onChange={event => updateApp(index, { label: event.target.value })}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={t('observability.bindings.removeApp', { number: index + 1 })}
                  onClick={() => update({ apps: draft.apps.filter((_, at) => at !== index) })}
                >
                  {t('observability.bindings.remove')}
                </Button>
              </div>
            ))
          )}
        </section>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={!ready || saveBinding.isPending}
          onClick={() =>
            saveBinding.mutate(
              { ...payload(), ...(stored ? { id: stored.id } : {}) },
              {
                onSuccess: () => {
                  toast.success(t('observability.bindings.saved'));
                  onDone?.();
                },
                onError: error => toast.error(errorMessage(error)),
              },
            )
          }
        >
          {t('observability.bindings.save')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!ready || checkBinding.isPending}
          onClick={() => checkBinding.mutate(payload(), { onSuccess: setResult, onError: error => toast.error(errorMessage(error)) })}
        >
          {checkBinding.isPending ? t('observability.check.running') : t('observability.check.run')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto"
          aria-label={t('observability.bindings.removeAria', { title })}
          disabled={removeBinding.isPending}
          onClick={() =>
            stored
              ? removeBinding.mutate(stored.id, { onError: error => toast.error(errorMessage(error)) })
              : onDone?.()
          }
        >
          {t('observability.bindings.removeBinding')}
        </Button>
      </div>
      {result && <CheckResult result={result} />}
    </SourceItemCard>
  );
}

/**
 * Settings › Підключення › Google Cloud: the organization's Google Cloud accounts (each its own key)
 * and this Factory's bindings — which Google Cloud project it reads through which account, and what:
 * logs and crashes (our adapter) and «База», the project's Firestore through MCP Toolbox run under
 * the hood. A Factory may have several bindings. Without `factoryId` every Factory's bindings show.
 * `linkAccountId` opens a new binding through that account (picked in «Додати підключення»).
 */
export function GoogleCloudService({ factoryId, linkAccountId }: { factoryId?: string; linkAccountId?: string } = {}) {
  const { t } = useTranslation('settings');
  const state = useFirebaseStateQuery();
  const factoriesQuery = useFactoriesQuery();
  const [addingAccount, setAddingAccount] = useState(false);
  const [drafts, setDrafts] = useState<number[]>(linkAccountId ? [0] : []);
  const [nextDraft, setNextDraft] = useState(linkAccountId ? 1 : 0);
  const accounts = state.data?.accounts ?? [];
  const allBindings = state.data?.bindings ?? [];
  const bindings = allBindings.filter(binding => !factoryId || binding.factoryProjectId === factoryId);
  const factories: Factory[] = factoriesQuery.data ?? [];
  const factoryName = (id: string) => factories.find(factory => factory.id === id)?.name ?? id;

  const description = state.isPending
    ? t('observability.source.checking')
    : state.isError
      ? errorMessage(state.error)
      : accounts.length > 0
        ? t('observability.source.ready')
        : t('observability.source.notConnected');
  const action = state.isError ? (
    <Button size="sm" variant="ghost" onClick={() => void state.refetch()}>
      {t('intake.retry')}
    </Button>
  ) : undefined;

  const addBinding = () => {
    setDrafts(current => [...current, nextDraft]);
    setNextDraft(next => next + 1);
  };
  const newDraft = (): BindingDraft => {
    const account = accounts.find(candidate => candidate.id === linkAccountId) ?? (accounts.length === 1 ? accounts[0] : undefined);
    return {
      factoryProjectId: factoryId ?? (factories.length === 1 ? factories[0]!.id : ''),
      accountId: account?.id ?? '',
      projectId: account?.projectId ?? '',
      projectNumber: '',
      logs: true,
      crashes: false,
      apps: [],
      database: { enabled: false },
    };
  };

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Txt as="p" variant="caption" tone="muted">
          {description}
        </Txt>
        {action}
      </div>

      <div className="flex flex-col gap-3">
        <ListHeader
          title={t('observability.accounts.title')}
          action={
            <Button size="sm" disabled={state.isPending || state.isError} onClick={() => setAddingAccount(true)}>
              {t('observability.accounts.add')}
            </Button>
          }
        />
        {accounts.length === 0 ? (
          <Txt tone="muted" as="p" variant="caption">
            {t('observability.accounts.none')}
          </Txt>
        ) : (
          accounts.map(account => <AccountCard key={account.id} account={account} bindings={allBindings} factoryName={factoryName} />)
        )}
      </div>

      <div className="flex flex-col gap-3">
        <ListHeader
          title={t('observability.bindings.heading')}
          action={
            <Button size="sm" disabled={accounts.length === 0} onClick={addBinding}>
              {t('observability.bindings.add')}
            </Button>
          }
        />
        {accounts.length === 0 ? (
          <Txt tone="muted" as="p" variant="caption">
            {t('observability.bindings.needsAccount')}
          </Txt>
        ) : bindings.length === 0 && drafts.length === 0 ? (
          <Txt tone="muted" as="p" variant="caption">
            {t('observability.bindings.none')}
          </Txt>
        ) : null}
        {bindings.map(binding => (
          <BindingCard key={binding.id} stored={binding} draft={draftOf(binding)} accounts={accounts} factories={factories} />
        ))}
        {drafts.map(draft => (
          <BindingCard
            key={`draft-${draft}`}
            draft={newDraft()}
            accounts={accounts}
            factories={factories}
            onDone={() => setDrafts(current => current.filter(id => id !== draft))}
          />
        ))}
      </div>

      {addingAccount && <AccountKeyDialog onClose={() => setAddingAccount(false)} />}
    </>
  );
}
