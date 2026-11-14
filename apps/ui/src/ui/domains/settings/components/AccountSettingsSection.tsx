import { Badge } from '@mastra/playground-ui/components/Badge';
import { Button } from '@mastra/playground-ui/components/Button';
import { CopyInput } from '@mastra/playground-ui/components/CopyInput';
import { Input } from '@mastra/playground-ui/components/Input';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { RelativeTimestamp } from '@mastra/playground-ui/components/RelativeTimestamp';
import { Skeleton } from '@mastra/playground-ui/components/Skeleton';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LogOut, Monitor, Pencil, Smartphone } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { useApiConfig } from '../../../../api/config';
import { queryKeys } from '../../../../api/keys';
import { useFactoryAuth } from '../../../../hooks/useFactoryAuth';
import {
  currentSession,
  describeUserAgent,
  listSessions,
  revokeOtherSessions,
  revokeSession,
  updateProfile,
} from '../../auth/services/team';
import type { SignInSession } from '../../auth/services/team';
import { AvatarPicker } from './team/AvatarPicker';
import { useGithubStatusQuery } from '../../../../hooks/useGithubStatus';
import { clearMastraCodeStorage, redirectToLogout } from '../../auth/services/auth';
import { SettingsContainer, SettingsRow, SettingsSkeleton } from '@mastra/playground-ui/new/settings';

import { SettingsSubsection } from './SettingsSubsection';
import { UserGithubConnectionRow } from './UserGithubConnectionRow';
import { translator } from '../../../i18n/t';

const tk = translator('settings');

// Product names stay as they are; only descriptive labels are translated, at call time.
const AUTH_PROVIDER_LABELS: Record<string, () => string> = {
  'better-auth': () => tk('account.authProviders.betterAuth'),
};

function authProviderLabel(provider: string | undefined): string {
  if (!provider) return tk('account.authProviders.unknown');
  return (
    AUTH_PROVIDER_LABELS[provider]?.() ??
    provider
      .split('-')
      .map(part => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ')
  );
}

function AccountValue({ children }: { children: string }) {
  return (
    <Txt tone="muted" as="span" variant="caption" className="truncate">
      {children}
    </Txt>
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function useRefreshAuth() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: queryKeys.factoryAuth() });
}

/** The name, with a pencil to edit it in place (better-auth `update-user`). */
function EditableName({ name }: { name: string }) {
  const { t } = useTranslation('settings');
  const { baseUrl } = useApiConfig();
  const refresh = useRefreshAuth();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const save = useMutation({
    mutationFn: (next: string) => updateProfile(baseUrl, { name: next }),
    onSuccess: async () => {
      await refresh();
      setEditing(false);
    },
  });
  const trimmed = draft.trim();

  if (!editing) {
    return (
      <Button
        size="sm"
        variant="ghost"
        aria-label={t('account.editName')}
        onClick={() => {
          setDraft(name);
          setEditing(true);
        }}
      >
        <span data-testid="account-name">{name}</span>
        <Pencil size={14} aria-hidden="true" />
      </Button>
    );
  }
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (trimmed && trimmed !== name) save.mutate(trimmed);
    else setEditing(false);
  };
  return (
    <form onSubmit={submit} className="flex flex-col items-end gap-2">
      <div className="flex items-center gap-2">
        <Input
          size="sm"
          autoFocus
          maxLength={80}
          aria-label={t('account.nameLabel')}
          value={draft}
          onChange={event => setDraft(event.target.value)}
        />
        <Button type="submit" size="sm" variant="primary" disabled={!trimmed || save.isPending}>
          {t('account.saveName')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
          {t('account.cancelEdit')}
        </Button>
      </div>
      {save.isError ? (
        <Notice variant="destructive" role="alert">
          {t('account.sessions.failed', { message: errorText(save.error) })}
        </Notice>
      ) : null}
    </form>
  );
}

function deviceLabel(session: SignInSession): { label: string; mobile: boolean } {
  const device = describeUserAgent(session.userAgent);
  if (!device) return { label: tk('account.sessions.unknownDevice'), mobile: false };
  const label =
    device.browser && device.os
      ? tk('account.sessions.device', { browser: device.browser, os: device.os })
      : (device.browser ?? device.os ?? tk('account.sessions.unknownDevice'));
  return { label, mobile: device.mobile };
}

function SessionRow({ session, current }: { session: SignInSession; current: boolean }) {
  const { t } = useTranslation('settings');
  const { baseUrl } = useApiConfig();
  const queryClient = useQueryClient();
  const revoke = useMutation({
    mutationFn: () => revokeSession(baseUrl, session.token),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.signInSessions() }),
  });
  const { label, mobile } = deviceLabel(session);
  const Icon = mobile ? Smartphone : Monitor;

  return (
    <SettingsRow
      label={
        <span className="flex items-center gap-2">
          <Icon size={16} aria-hidden="true" />
          {label}
        </span>
      }
      description={
        <span className="flex items-center gap-1">
          {session.ipAddress || t('account.sessions.unknownIp')},
          <RelativeTimestamp value={new Date(session.createdAt)} />
        </span>
      }
    >
      {current ? (
        <Badge size="sm" variant="neutral">
          {t('account.sessions.current')}
        </Badge>
      ) : (
        <Button
          size="sm"
          variant="ghost"
          disabled={revoke.isPending}
          aria-label={t('account.sessions.revokeNamed', { device: label })}
          onClick={() => revoke.mutate()}
        >
          {t('account.sessions.revoke')}
        </Button>
      )}
      {revoke.isError ? (
        <Notice variant="destructive" role="alert">
          {t('account.sessions.failed', { message: errorText(revoke.error) })}
        </Notice>
      ) : null}
    </SettingsRow>
  );
}

/** Where the person is signed in (better-auth sessions): device from the User-Agent, IP, when. */
function SessionsList() {
  const { t } = useTranslation('settings');
  const { baseUrl } = useApiConfig();
  const queryClient = useQueryClient();
  const sessions = useQuery({
    queryKey: queryKeys.signInSessions(),
    queryFn: async () => {
      const [list, current] = await Promise.all([listSessions(baseUrl), currentSession(baseUrl)]);
      return { list, currentId: current?.session.id };
    },
  });
  const revokeOthers = useMutation({
    mutationFn: () => revokeOtherSessions(baseUrl),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.signInSessions() }),
  });

  return (
    <SettingsSubsection scope="personal" title={t('account.sessions.title')} description={t('account.sessions.description')}>
      <SettingsContainer>
        {sessions.isPending ? (
          <SettingsRow label={<Skeleton className="h-4 w-40" />} />
        ) : sessions.isError ? (
          <div className="p-4">
            <Notice variant="destructive" role="alert">
              {t('account.sessions.loadFailed', { message: errorText(sessions.error) })}
            </Notice>
          </div>
        ) : (
          <>
            {[...sessions.data.list]
              .sort((a, b) => Number(b.id === sessions.data.currentId) - Number(a.id === sessions.data.currentId))
              .map(session => (
                <SessionRow key={session.id} session={session} current={session.id === sessions.data.currentId} />
              ))}
            {sessions.data.list.length > 1 ? (
              <SettingsRow label="">
                <Button size="sm" disabled={revokeOthers.isPending} onClick={() => revokeOthers.mutate()}>
                  {t('account.sessions.revokeOthers')}
                </Button>
              </SettingsRow>
            ) : null}
            {revokeOthers.isError ? (
              <div className="p-4">
                <Notice variant="destructive" role="alert">
                  {t('account.sessions.failed', { message: errorText(revokeOthers.error) })}
                </Notice>
              </div>
            ) : null}
          </>
        )}
      </SettingsContainer>
    </SettingsSubsection>
  );
}

/** The person's own GitHub account: it links through the App's OAuth, so only on a server with an App. */
function AccountGithubRow() {
  const github = useGithubStatusQuery().data;
  if (!github?.connected || github.appConfigured === false) return null;
  return <UserGithubConnectionRow />;
}

export function AccountSettingsSection() {
  const { t } = useTranslation('settings');
  const auth = useFactoryAuth();
  const { baseUrl } = useApiConfig();
  const refreshAuth = useRefreshAuth();

  if (auth.isPending) {
    return (
      <SettingsSubsection scope="personal" title={t('account.profile.title')}>
        <SettingsContainer>
          <SettingsSkeleton label={t('account.loading')} rows={3} />
        </SettingsContainer>
      </SettingsSubsection>
    );
  }

  if (auth.isError) {
    return <Notice variant="destructive">{t('account.loadFailed')}</Notice>;
  }

  const state = auth.data;
  if (!state?.authEnabled) {
    return <Notice variant="info">{t('account.authDisabled')}</Notice>;
  }

  if (!state.authenticated) {
    return <Notice variant="info">{t('account.signInToView')}</Notice>;
  }

  const user = state.user;
  // better-auth (Google) lets people edit their name and avatar and see their sessions.
  const editable = state.provider === 'better-auth';
  const displayName = user?.name || user?.email || '';

  const logOut = () => {
    clearMastraCodeStorage();
    redirectToLogout(baseUrl);
  };

  return (
    <>
      <SettingsSubsection
        scope="personal"
        title={t('account.profile.title')}
        description={t('account.profile.description')}
      >
        <SettingsContainer>
          {editable ? (
            <SettingsRow label={t('account.avatar')} description={t('account.avatarDescription')}>
              <AvatarPicker
                name={displayName}
                src={user?.avatarUrl}
                editable
                onChange={async image => {
                  await updateProfile(baseUrl, { image });
                  await refreshAuth();
                }}
              />
            </SettingsRow>
          ) : null}
          <SettingsRow
            label={t('account.name')}
            description={editable ? t('account.nameDescription') : t('account.fromProvider')}
          >
            {editable && user?.name ? (
              <EditableName name={user.name} />
            ) : (
              <AccountValue>{user?.name ?? t('account.notProvided')}</AccountValue>
            )}
          </SettingsRow>
          <SettingsRow label={t('account.email')} description={t('account.emailDescription')}>
            <AccountValue>{user?.email ?? t('account.notProvided')}</AccountValue>
          </SettingsRow>
          <SettingsRow label={t('account.authentication')} description={t('account.howSignedIn')}>
            <AccountValue>{authProviderLabel(state.provider)}</AccountValue>
          </SettingsRow>
          {user?.userId && (
            <SettingsRow label={t('account.accountId.label')} description={t('account.accountId.description')}>
              <CopyInput value={user.userId} label={t('account.accountId.label')} copyLabel={t('account.accountId.copy')} />
            </SettingsRow>
          )}
          {user?.organizationId && (
            <SettingsRow label={t('account.organizationId.label')} description={t('account.organizationId.description')}>
              <CopyInput
                value={user.organizationId}
                label={t('account.organizationId.label')}
                copyLabel={t('account.organizationId.copy')}
              />
            </SettingsRow>
          )}
        </SettingsContainer>
      </SettingsSubsection>
      <AccountGithubRow />
      {editable ? <SessionsList /> : null}
      <SettingsSubsection scope="personal" title={t('account.session.title')}>
        <SettingsContainer>
          <SettingsRow label={t('account.session.logOut')} description={t('account.session.description')}>
            <Button type="button" size="sm" aria-label={t('account.session.logOutLabel')} onClick={logOut}>
              <LogOut aria-hidden="true" />
              {t('account.session.logOut')}
            </Button>
          </SettingsRow>
        </SettingsContainer>
      </SettingsSubsection>
    </>
  );
}
