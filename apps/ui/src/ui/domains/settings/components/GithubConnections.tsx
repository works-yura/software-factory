import { Badge } from '@mastra/playground-ui/components/Badge';
import { Button } from '@mastra/playground-ui/components/Button';
import { Input } from '@mastra/playground-ui/components/Input';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { Spinner } from '@mastra/playground-ui/components/Spinner';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { RotateCw } from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApiConfig } from '../../../../api/config';
import { useGithubConnectionMutations, useGithubConnectionsQuery } from '../../../../hooks/useGithubConnections';
import type { GithubConnection } from '../../workspaces/services/github';
import { connectGithub, manageGithubConnection } from '../../workspaces/services/github';
import { ConfirmDialog } from './connections/ConnectionDialogs';

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

export interface GithubTokenResult {
  connection: GithubConnection;
  replaced: boolean;
}

/**
 * A GitHub personal access token: the field, which scopes it needs, and connect (or, with `replace`,
 * replace that connection's token). A refusal shows why in a tinted panel and the button tries again.
 * The token is sent once and never shown back.
 */
export function GithubTokenForm({
  replace,
  onDone,
  onCancel,
}: {
  replace?: GithubConnection;
  onDone: (result: GithubTokenResult) => void;
  onCancel?: () => void;
}) {
  const { t } = useTranslation('settings');
  const { connectToken, replaceToken } = useGithubConnectionMutations();
  const mutation = replace ? replaceToken : connectToken;
  const [token, setToken] = useState('');
  const fieldId = useId();
  const hintId = useId();

  const submit = () => {
    const value = token.trim();
    if (!value) return;
    const done = (result: GithubTokenResult) => {
      setToken('');
      onDone(result);
    };
    if (replace) replaceToken.mutate({ id: replace.id, token: value }, { onSuccess: done });
    else connectToken.mutate(value, { onSuccess: done });
  };

  return (
    <form
      className="flex min-w-0 flex-col gap-3"
      onSubmit={event => {
        event.preventDefault();
        submit();
      }}
    >
      {mutation.isError && (
        <Notice variant="destructive" title={t('connections.connect.errorTitle')} role="alert">
          <Notice.Message>{errorMessage(mutation.error)}</Notice.Message>
        </Notice>
      )}
      <label htmlFor={fieldId} className="flex flex-col gap-1.5">
        <Txt as="span" variant="label" tone="ink">
          {t('githubConnections.tokenLabel')}
        </Txt>
      </label>
      <Input
        id={fieldId}
        type="password"
        value={token}
        autoComplete="off"
        spellCheck={false}
        aria-describedby={hintId}
        placeholder="ghp_… / github_pat_…"
        className="font-mono"
        onChange={event => setToken(event.target.value)}
      />
      <Txt as="p" id={hintId} variant="caption" tone="muted">
        {t('githubConnections.tokenHint')}
      </Txt>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" variant="primary" disabled={!token.trim() || mutation.isPending}>
          {mutation.isPending ? (
            <>
              <Spinner size="sm" aria-hidden />
              {t('githubConnections.connecting')}
            </>
          ) : mutation.isError ? (
            <>
              <RotateCw aria-hidden className="size-4" />
              {t('connections.connect.retry')}
            </>
          ) : replace ? (
            t('githubConnections.replace')
          ) : (
            t('githubConnections.submit')
          )}
        </Button>
        {onCancel && (
          <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
            {t('githubConnections.cancel')}
          </Button>
        )}
      </div>
    </form>
  );
}

/** What a connection is: the App, a stored token, or the server's env token kept for an old connection. */
function KindBadge({ connection }: { connection: Pick<GithubConnection, 'kind' | 'tokenSource'> }) {
  const { t } = useTranslation('settings');
  const label =
    connection.kind === 'app'
      ? t('githubConnections.kindApp')
      : connection.tokenSource === 'env'
        ? t('githubConnections.kindEnvToken')
        : t('githubConnections.kindToken');
  return (
    <Badge size="sm" variant={connection.kind === 'app' ? 'info' : 'neutral'} className="shrink-0">
      {label}
    </Badge>
  );
}

function accountOf(connection: GithubConnection, unknown: string): string {
  return connection.accountLogin ? `@${connection.accountLogin}` : unknown;
}

/** One connection: kind, account, repositories, its state, and (for admins) what can be done with it. */
function ConnectionItem({ connection, canManage }: { connection: GithubConnection; canManage: boolean }) {
  const { t } = useTranslation('settings');
  const { baseUrl } = useApiConfig();
  const { disconnect } = useGithubConnectionMutations();
  const [replacing, setReplacing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const account = accountOf(connection, t('githubConnections.unknownAccount'));
  const attention = connection.status === 'needs_attention';

  return (
    <li aria-label={account} className="border-border1 flex min-w-0 flex-col gap-3 border-b py-3 last:border-b-0">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <span className="flex min-w-0 items-center gap-2">
          <Txt as="span" variant="body-sm" tone="ink" className="truncate">
            {account}
          </Txt>
          <KindBadge connection={connection} />
          {attention && (
            <Badge size="sm" variant="warning" className="shrink-0">
              {t('githubConnections.needsAttention')}
            </Badge>
          )}
        </span>
        <Txt as="span" variant="caption" tone="muted">
          {connection.repositoryCount === null
            ? t('githubConnections.repositoriesUnknown')
            : t('githubConnections.repositories', { repos: connection.repositoryCount })}
        </Txt>
      </div>
      {attention && connection.error && (
        <Notice variant="warning" title={t('githubConnections.needsAttention')} role="status">
          <Notice.Message>{connection.error}</Notice.Message>
        </Notice>
      )}
      {disconnect.isError && (
        <Notice variant="destructive" title={t('githubConnections.disconnectFailed')} role="alert">
          <Notice.Message>{errorMessage(disconnect.error)}</Notice.Message>
        </Notice>
      )}
      {canManage && !replacing && (
        <div className="flex flex-wrap items-center gap-2">
          {connection.kind === 'app' ? (
            <Button size="sm" onClick={() => manageGithubConnection(baseUrl)}>
              {t('githubConnections.manage')}
            </Button>
          ) : (
            <Button size="sm" onClick={() => setReplacing(true)}>
              {t('githubConnections.replaceToken')}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setConfirming(true)}>
            {t('githubConnections.disconnect')}
          </Button>
        </div>
      )}
      {replacing && (
        <GithubTokenForm replace={connection} onDone={() => setReplacing(false)} onCancel={() => setReplacing(false)} />
      )}
      {confirming && (
        <ConfirmDialog
          title={t('githubConnections.disconnectTitle', { account })}
          body={t('githubConnections.disconnectBody')}
          confirm={t('githubConnections.disconnect')}
          cancel={t('githubConnections.cancel')}
          pending={disconnect.isPending}
          onConfirm={() => disconnect.mutate(connection.id, { onSettled: () => setConfirming(false) })}
          onClose={() => setConfirming(false)}
        />
      )}
    </li>
  );
}

/**
 * The two ways to add GitHub: through the server's GitHub App (when it has one) and a private
 * token. Used by «Додати ще» on the GitHub page.
 */
export function GithubAddWays({ appConfigured, onDone }: { appConfigured: boolean; onDone: (result: GithubTokenResult) => void }) {
  const { t } = useTranslation('settings');
  const { baseUrl } = useApiConfig();
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {appConfigured && (
        <div className="flex flex-col gap-1.5">
          <Txt as="span" variant="label" tone="ink">
            {t('githubConnections.viaApp')}
          </Txt>
          <Txt as="p" variant="caption" tone="muted">
            {t('githubConnections.viaAppHint')}
          </Txt>
          <Button size="sm" className="self-start" onClick={() => connectGithub(baseUrl)}>
            {t('githubConnections.viaApp')}
          </Button>
        </div>
      )}
      <div className="flex flex-col gap-1.5">
        <Txt as="span" variant="label" tone="ink">
          {t('githubConnections.viaToken')}
        </Txt>
        <GithubTokenForm onDone={onDone} />
      </div>
    </div>
  );
}

/**
 * Every GitHub connection of the organization — App installations and tokens, side by side — with
 * their accounts and repositories; admins replace, manage and disconnect them and add more.
 */
export function GithubConnectionsList() {
  const { t } = useTranslation('settings');
  const query = useGithubConnectionsQuery();
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState<GithubTokenResult>();

  if (query.isPending) {
    return (
      <span className="flex items-center gap-2" aria-label={t('githubConnections.list')}>
        <Spinner size="sm" aria-hidden />
      </span>
    );
  }
  if (query.isError) {
    return (
      <Notice
        variant="destructive"
        title={t('connections.connect.errorTitle')}
        role="alert"
        action={
          <Button size="sm" onClick={() => void query.refetch()}>
            <RotateCw aria-hidden className="size-4" />
            {t('connections.connect.retry')}
          </Button>
        }
      >
        <Notice.Message>{t('githubConnections.loadFailed', { error: errorMessage(query.error) })}</Notice.Message>
      </Notice>
    );
  }

  const { connections, canManage, appConfigured } = query.data;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {connections.length === 0 ? (
        <Txt as="p" variant="caption" tone="muted">
          {t('githubConnections.none')}
        </Txt>
      ) : (
        <ul aria-label={t('githubConnections.list')} className="flex min-w-0 flex-col">
          {connections.map(connection => (
            <ConnectionItem key={connection.id} connection={connection} canManage={canManage} />
          ))}
        </ul>
      )}
      {added && (
        <Notice
          variant="success"
          title={t(added.replaced ? 'githubConnections.replacedTitle' : 'githubConnections.connectedTitle', {
            account: added.connection.accountLogin ?? '',
          })}
          role="status"
        >
          {added.connection.repositoryCount !== null && (
            <Notice.Message>{t('githubConnections.connectedBody', { repos: added.connection.repositoryCount })}</Notice.Message>
          )}
        </Notice>
      )}
      {!canManage ? (
        <Txt as="p" variant="caption" tone="muted">
          {t('githubConnections.adminOnly')}
        </Txt>
      ) : adding || connections.length === 0 ? (
        <GithubAddWays
          appConfigured={appConfigured}
          onDone={result => {
            setAdded(result);
            setAdding(false);
          }}
        />
      ) : (
        <Button size="sm" variant="ghost" className="self-start" onClick={() => (setAdded(undefined), setAdding(true))}>
          {t('githubConnections.addMore')}
        </Button>
      )}
    </div>
  );
}
