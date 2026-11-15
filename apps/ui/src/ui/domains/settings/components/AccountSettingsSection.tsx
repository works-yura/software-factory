import { Button } from '@mastra/playground-ui/components/Button';
import { CopyInput } from '@mastra/playground-ui/components/CopyInput';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { LogOut } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useApiConfig } from '../../../../api/config';
import { useFactoryAuth } from '../../../../hooks/useFactoryAuth';
import { useUpdateProfile } from '../hooks/useAccount';
import { EditableName } from './account/EditableName';
import { SessionsList } from './account/SessionsList';
import { AvatarPicker } from './team/AvatarPicker';
import { useGithubStatusQuery } from '../../../../hooks/useGithubStatus';
import { clearMastraCodeStorage, redirectToLogout } from '../../auth/services/auth';
import { SettingsContainer, SettingsRow, SettingsSkeleton } from '@mastra/playground-ui/new/settings';

import { SettingsSubsection } from './SettingsSubsection';
import { UserGithubConnectionRow } from './UserGithubConnectionRow';
import { translator } from '../../../i18n/t';
import { AssistantAccountSettings, AssistantAccountSources } from '../../assistant/AssistantOverlay';

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
    <Txt tone="muted" as="span" variant="caption" className="truncate" title={children}>
      {children}
    </Txt>
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
  const updateProfile = useUpdateProfile();

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
                onChange={image => updateProfile.mutateAsync({ image })}
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
      {user?.organizationId ? (
        <SettingsSubsection
          id="assistant"
          // The assistant's panel links here (`#assistant`) to pick another model after a failed turn.
          ref={element => {
            if (element && window.location.hash === '#assistant') element.scrollIntoView?.({ block: 'start' });
          }}
          scope="personal"
          title={t('account.assistant.title')}
          description={t('account.assistant.description')}
        >
          <AssistantAccountSettings />
        </SettingsSubsection>
      ) : null}
      {user?.organizationId ? (
        <SettingsSubsection
          scope="personal"
          title={t('account.assistantSources.title')}
          description={t('account.assistantSources.description')}
        >
          <AssistantAccountSources />
        </SettingsSubsection>
      ) : null}
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
