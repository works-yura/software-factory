import { Button } from '@mastra/playground-ui/components/Button';
import { CopyButton } from '@mastra/playground-ui/components/CopyButton';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { Skeleton } from '@mastra/playground-ui/components/Skeleton';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { LogOut } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useApiConfig } from '../../../../api/config';
import { useFactoryAuth } from '../../../../hooks/useFactoryAuth';
import { clearMastraCodeStorage, redirectToLogout } from '../../auth/services/auth';
import { SettingsContainer, SettingsRow } from '@mastra/playground-ui/new/settings';

import { SettingsSubsection } from './SettingsSubsection';
import { translator } from '../../../i18n/t';

const tk = translator('settings');

// Product names stay as they are; only descriptive labels are translated, at call time.
const AUTH_PROVIDER_LABELS: Record<string, () => string> = {
  workos: () => 'WorkOS',
  'better-auth': () => tk('account.authProviders.betterAuth'),
  'mastra-studio': () => 'Mastra Studio',
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

function AccountValue({ children, mono = false }: { children: string; mono?: boolean }) {
  return (
    <Txt tone="muted" as="span" variant="caption" font={mono ? 'mono' : undefined} className="truncate">
      {children}
    </Txt>
  );
}

function CopyableAccountValue({ value, tooltip }: { value: string; tooltip: string }) {
  return (
    <div className="flex min-w-0 items-center gap-1">
      <AccountValue mono>{value}</AccountValue>
      <CopyButton content={value} size="icon-sm" variant="ghost" tooltip={tooltip} />
    </div>
  );
}

function AccountSettingsSkeleton() {
  const { t } = useTranslation('settings');
  return (
    <SettingsContainer>
      <SettingsRow label={t('account.name')}>
        <Skeleton className="h-4 w-28" />
      </SettingsRow>
      <SettingsRow label={t('account.email')}>
        <Skeleton className="h-4 w-40" />
      </SettingsRow>
      <SettingsRow label={t('account.authentication')}>
        <Skeleton className="h-4 w-24" />
      </SettingsRow>
    </SettingsContainer>
  );
}

export function AccountSettingsSection() {
  const { t } = useTranslation('settings');
  const auth = useFactoryAuth();
  const { baseUrl } = useApiConfig();

  if (auth.isPending) {
    return (
      <SettingsSubsection scope="personal" title={t('account.profile.title')}>
        <AccountSettingsSkeleton />
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

  const logOut = () => {
    clearMastraCodeStorage();
    redirectToLogout(baseUrl);
  };

  return (
    <div className="flex flex-col gap-8">
      <SettingsSubsection
        scope="personal"
        title={t('account.profile.title')}
        description={t('account.profile.description')}
      >
        <SettingsContainer>
          <SettingsRow label={t('account.name')}>
            <AccountValue>{user?.name ?? t('account.notProvided')}</AccountValue>
          </SettingsRow>
          <SettingsRow label={t('account.email')}>
            <AccountValue>{user?.email ?? t('account.notProvided')}</AccountValue>
          </SettingsRow>
          <SettingsRow label={t('account.authentication')}>
            <AccountValue>{authProviderLabel(state.provider)}</AccountValue>
          </SettingsRow>
          {user?.userId && (
            <SettingsRow label={t('account.accountId.label')} description={t('account.accountId.description')}>
              <CopyableAccountValue value={user.userId} tooltip={t('account.accountId.copy')} />
            </SettingsRow>
          )}
          {user?.organizationId && (
            <SettingsRow label={t('account.organizationId.label')} description={t('account.organizationId.description')}>
              <CopyableAccountValue value={user.organizationId} tooltip={t('account.organizationId.copy')} />
            </SettingsRow>
          )}
        </SettingsContainer>
      </SettingsSubsection>
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
    </div>
  );
}
