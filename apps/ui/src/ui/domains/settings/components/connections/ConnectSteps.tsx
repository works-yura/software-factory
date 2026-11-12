import { Button } from '@mastra/playground-ui/components/Button';
import { DialogBody, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@mastra/playground-ui/components/Dialog';
import { Input } from '@mastra/playground-ui/components/Input';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { Spinner } from '@mastra/playground-ui/components/Spinner';
import { Textarea } from '@mastra/playground-ui/components/Textarea';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { ArrowLeft, ChevronRight, KeyRound, RotateCw } from 'lucide-react';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useClickUpStatusQuery } from '../../../../../hooks/useClickUp';
import { useFirebaseMutations } from '../../../../../hooks/useFirebase';
import { useGithubStatusQuery } from '../../../../../hooks/useGithubStatus';
import { useGitLabStatusQuery } from '../../../../../hooks/useGitLabData';
import type { FIRST_PARTY } from '../../connections/connections';
import type { FirebaseAccount } from '../../services/firebase';
import { ClickUpService } from '../ClickUpService';
import { GitHubService, GitLabService } from '../SourceControlServices';
import { ConnectionIcon } from './ConnectionIcon';

/** Where a pick leads: a connection's page (`?connection=`), with an account to link. */
export type ConnectionTarget = { connection: string; account?: string };

export type FirstParty = (typeof FIRST_PARTY)[number];

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The header and footer every connect step shares: logo, «Підключити X», one line; «← Назад» and the step's action. */
function StepFrame({ kind, children, onBack, action }: { kind: FirstParty; children: ReactNode; onBack: () => void; action?: ReactNode }) {
  const { t } = useTranslation('settings');
  return (
    <>
      <DialogHeader className="flex-row items-start gap-2.5">
        <ConnectionIcon kind={kind} />
        <span className="flex min-w-0 flex-col gap-0.5">
          <DialogTitle>{t('connections.connect.title', { name: t(`connections.kinds.${kind}`) })}</DialogTitle>
          <DialogDescription className="text-body-sm">{t(`connections.connect.subtitle.${kind}`)}</DialogDescription>
        </span>
      </DialogHeader>
      <DialogBody className="gap-4">{children}</DialogBody>
      <DialogFooter className="mt-auto justify-between pt-3 max-sm:pb-[max(env(safe-area-inset-bottom),0.5rem)]">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft aria-hidden className="size-4" />
          {t('connections.connect.back')}
        </Button>
        {action}
      </DialogFooter>
    </>
  );
}

/** A choice in a step, built like the catalog's rows. */
function ChoiceRow({ icon, name, detail, onSelect }: { icon: ReactNode; name: string; detail?: string; onSelect: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className="text-body-sm text-muted-foreground hover:bg-fill hover:text-foreground focus-visible:bg-fill focus-visible:text-foreground flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left outline-none"
      >
        {icon}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-body-sm text-foreground truncate">{name}</span>
          {detail && <span className="text-meta text-muted-foreground truncate">{detail}</span>}
        </span>
        <ChevronRight aria-hidden className="text-muted-foreground size-4 shrink-0" />
      </button>
    </li>
  );
}

/**
 * Connect Google Cloud: through an account the organization has (a new binding for this Factory
 * opens on its page), or a new service-account key — pasted or picked, sent once, never shown again.
 * Adding shows its progress, a failure in a tinted panel with «Спробувати знову», and on success
 * goes on to pick the project.
 */
export function GoogleCloudConnect({
  accounts,
  onBack,
  onPick,
}: {
  accounts: readonly FirebaseAccount[];
  onBack: () => void;
  onPick: (target: ConnectionTarget) => void;
}) {
  const { t } = useTranslation('settings');
  const { addAccount } = useFirebaseMutations();
  const [mode, setMode] = useState<'choose' | 'key'>(accounts.length ? 'choose' : 'key');
  const [name, setName] = useState('');
  const [keyJson, setKeyJson] = useState('');
  const added = addAccount.data?.account;

  const submit = () => addAccount.mutate({ serviceAccountJson: keyJson, ...(name.trim() ? { name: name.trim() } : {}) });

  if (added) {
    return (
      <StepFrame
        kind="google-cloud"
        onBack={onBack}
        action={
          <Button size="sm" variant="primary" onClick={() => onPick({ connection: 'google-cloud', account: added.id })}>
            {t('connections.connect.bindProject')}
          </Button>
        }
      >
        <Notice variant="success" title={t('connections.connect.successTitle', { name: added.name })} role="status">
          <Notice.Message>{t('connections.connect.successBody')}</Notice.Message>
        </Notice>
      </StepFrame>
    );
  }

  if (mode === 'choose') {
    return (
      <StepFrame kind="google-cloud" onBack={onBack}>
        <Txt as="p" variant="caption" tone="muted">
          {t('connections.connect.chooseAccount')}
        </Txt>
        <ul className="-mx-2 flex flex-col gap-0.5">
          {accounts.map(account => (
            <ChoiceRow
              key={account.id}
              icon={<ConnectionIcon kind="google-cloud" />}
              name={account.name}
              detail={account.clientEmail}
              onSelect={() => onPick({ connection: 'google-cloud', account: account.id })}
            />
          ))}
          <ChoiceRow
            icon={
              <span aria-hidden className="grid size-8 shrink-0 place-items-center p-1.5">
                <KeyRound className="text-muted-foreground size-4" />
              </span>
            }
            name={t('connections.connect.newKey')}
            onSelect={() => setMode('key')}
          />
        </ul>
      </StepFrame>
    );
  }

  const failed = addAccount.isError;
  return (
    <StepFrame
      kind="google-cloud"
      onBack={() => (accounts.length ? (addAccount.reset(), setMode('choose')) : onBack())}
      action={
        <Button
          size="sm"
          variant="primary"
         
          disabled={!keyJson.trim() || addAccount.isPending}
          onClick={submit}
        >
          {addAccount.isPending ? (
            <>
              <Spinner size="sm" aria-hidden />
              {t('connections.connect.connecting')}
            </>
          ) : failed ? (
            <>
              <RotateCw aria-hidden className="size-4" />
              {t('connections.connect.retry')}
            </>
          ) : (
            t('connections.connect.submit')
          )}
        </Button>
      }
    >
      {failed && (
        <Notice variant="destructive" title={t('connections.connect.errorTitle')} role="alert">
          <Notice.Message>{errorMessage(addAccount.error)}</Notice.Message>
        </Notice>
      )}
      <Txt as="p" variant="caption" tone="muted">
        {t('connections.connect.newKeyHint')} {t('connections.connect.roles')}
      </Txt>
      <label className="flex flex-col gap-1.5">
        <Txt as="span" variant="label" tone="ink">
          {t('connections.connect.keyName')}
        </Txt>
        <Input value={name} placeholder={t('connections.connect.keyNamePlaceholder')} onChange={event => setName(event.target.value)} />
      </label>
      <label className="flex flex-col gap-1.5">
        <Txt as="span" variant="label" tone="ink">
          {t('connections.connect.key')}
        </Txt>
        <Textarea
          value={keyJson}
          rows={6}
          spellCheck={false}
          autoComplete="off"
          className="font-mono text-xs"
          placeholder='{"type": "service_account", …}'
          onChange={event => setKeyJson(event.target.value)}
        />
      </label>
      <label className="flex min-h-11 cursor-pointer items-center self-start md:min-h-0">
        <input
          type="file"
          accept="application/json,.json"
          className="sr-only"
          aria-label={t('connections.connect.pickFile')}
          onChange={async event => {
            const file = event.target.files?.[0];
            if (file) setKeyJson(await file.text());
          }}
        />
        <Txt as="span" variant="caption" tone="muted" className="underline">
          {t('connections.connect.pickFile')}
        </Txt>
      </label>
    </StepFrame>
  );
}

/** Each organization-wide source's state: whether it is connected, in one line, and how to retry reading it. */
function useSourceState(kind: Exclude<FirstParty, 'google-cloud'>) {
  const { t } = useTranslation('settings');
  const clickup = useClickUpStatusQuery();
  const github = useGithubStatusQuery();
  const gitlab = useGitLabStatusQuery();
  const query = kind === 'clickup' ? clickup : kind === 'github' ? github : gitlab;
  const connected =
    kind === 'clickup'
      ? clickup.data?.connected === true
      : kind === 'github'
        ? github.data?.connected === true || github.data?.mode === 'token'
        : gitlab.data?.configured === true;
  const fromEnv = kind === 'github' ? github.data?.mode === 'token' : kind === 'gitlab' ? gitlab.data?.mode === 'direct' : false;
  const detail =
    kind === 'clickup' && clickup.data?.workspaces.length
      ? clickup.data.workspaces.join(', ')
      : fromEnv
        ? t('connections.states.env')
        : undefined;
  return { pending: query.isPending, error: query.isError ? query.error : undefined, retry: () => void query.refetch(), connected, detail };
}

/**
 * Connect ClickUp, GitHub or GitLab: their state at the top — connected (and as what), not yet, or
 * a tinted panel when it could not be read — and their own controls below (GitLab's connect, the
 * GitHub App, ClickUp's import switch); «Відкрити налаштування» goes to the connection's page.
 */
export function SourceConnect({
  kind,
  onBack,
  onPick,
}: {
  kind: Exclude<FirstParty, 'google-cloud'>;
  onBack: () => void;
  onPick: (target: ConnectionTarget) => void;
}) {
  const { t } = useTranslation('settings');
  const state = useSourceState(kind);
  return (
    <StepFrame
      kind={kind}
      onBack={onBack}
      action={
        state.error ? (
          <Button size="sm" variant="primary" onClick={state.retry}>
            <RotateCw aria-hidden className="size-4" />
            {t('connections.connect.retry')}
          </Button>
        ) : (
          <Button size="sm" variant="primary" disabled={state.pending} onClick={() => onPick({ connection: kind })}>
            {t('connections.connect.openSettings')}
          </Button>
        )
      }
    >
      {state.pending ? (
        <span className="flex items-center gap-2">
          <Spinner size="sm" aria-hidden />
        </span>
      ) : state.error ? (
        <Notice variant="destructive" title={t('connections.connect.errorTitle')} role="alert">
          <Notice.Message>{t('connections.connect.statusFailed', { error: errorMessage(state.error) })}</Notice.Message>
        </Notice>
      ) : (
        <Notice
          variant={state.connected ? 'success' : 'info'}
          title={state.connected ? t('connections.connect.connectedTitle') : t('connections.connect.notConnectedTitle')}
          role="status"
        >
          {state.detail && <Notice.Message>{state.detail}</Notice.Message>}
        </Notice>
      )}
      {!state.pending && !state.error && (kind === 'clickup' ? <ClickUpService /> : kind === 'github' ? <GitHubService /> : <GitLabService />)}
    </StepFrame>
  );
}
