import { Badge } from '@mastra/playground-ui/components/Badge';
import { Button } from '@mastra/playground-ui/components/Button';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { RelativeTimestamp } from '@mastra/playground-ui/components/RelativeTimestamp';
import {
  SettingsContainer,
  SettingsItem,
  SettingsItemIcon,
  SettingsListHeader,
  SettingsNoticeRow,
  SettingsSkeleton,
} from '@mastra/playground-ui/new/settings';
import { Monitor, Smartphone } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { describeUserAgent } from '../../../auth/services/team';
import type { SignInSession } from '../../../auth/services/team';
import { translator } from '../../../../i18n/t';
import { errorText } from '../../../../../lib/errorText';
import { useRevokeOtherSessions, useRevokeSession, useSignInSessions } from '../../hooks/useAccount';
import { SettingsSubsection } from '../SettingsSubsection';

const tk = translator('settings');

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
  const revoke = useRevokeSession(session.token);
  const { label, mobile } = deviceLabel(session);
  const Icon = mobile ? Smartphone : Monitor;
  const ip = session.ipAddress || t('account.sessions.unknownIp');

  return (
    <SettingsItem
      media={
        <SettingsItemIcon>
          <Icon />
        </SettingsItemIcon>
      }
      title={label}
      description={
        <span title={ip}>
          {ip}, <RelativeTimestamp value={new Date(session.createdAt)} />
        </span>
      }
      notice={
        revoke.isError ? (
          <Notice variant="destructive" role="alert">
            {t('account.sessions.failed', { message: errorText(revoke.error) })}
          </Notice>
        ) : null
      }
    >
      {current ? (
        <Badge size="sm" variant="neutral">
          {t('account.sessions.current')}
        </Badge>
      ) : (
        <Button
          size="sm"
          disabled={revoke.isPending}
          aria-label={t('account.sessions.revokeNamed', { device: label })}
          onClick={() => revoke.mutate()}
        >
          {t('account.sessions.revoke')}
        </Button>
      )}
    </SettingsItem>
  );
}

/** Where the person is signed in (better-auth sessions): device from the User-Agent, IP, when. */
export function SessionsList() {
  const { t } = useTranslation('settings');
  const sessions = useSignInSessions();
  const revokeOthers = useRevokeOtherSessions();

  return (
    <SettingsSubsection scope="personal" title={t('account.sessions.title')} description={t('account.sessions.description')}>
      <SettingsContainer>
        {sessions.isPending ? (
          <SettingsSkeleton label={t('account.sessions.title')} rows={2} variant="item" />
        ) : sessions.isError ? (
          <SettingsNoticeRow>
            <Notice variant="destructive" role="alert">
              {t('account.sessions.loadFailed', { message: errorText(sessions.error) })}
            </Notice>
          </SettingsNoticeRow>
        ) : (
          <>
            <SettingsListHeader
              action={
                sessions.data.list.length > 1 ? (
                  <Button size="sm" disabled={revokeOthers.isPending} onClick={() => revokeOthers.mutate()}>
                    {t('account.sessions.revokeOthers')}
                  </Button>
                ) : undefined
              }
            >
              {t('account.sessions.count', { count: sessions.data.list.length })}
            </SettingsListHeader>
            {[...sessions.data.list]
              .sort((a, b) => Number(b.id === sessions.data.currentId) - Number(a.id === sessions.data.currentId))
              .map(session => (
                <SessionRow key={session.id} session={session} current={session.id === sessions.data.currentId} />
              ))}
            <SettingsNoticeRow>
              {revokeOthers.isError ? (
                <Notice variant="destructive" role="alert">
                  {t('account.sessions.failed', { message: errorText(revokeOthers.error) })}
                </Notice>
              ) : null}
            </SettingsNoticeRow>
          </>
        )}
      </SettingsContainer>
    </SettingsSubsection>
  );
}
