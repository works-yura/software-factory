import { Button } from '@mastra/playground-ui/components/Button';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { SettingsContainer, SettingsListHeader, SettingsSkeleton } from '@mastra/playground-ui/new/settings';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useCan } from '../../../../hooks/useCan';
import { isOpenInvitation } from '../../auth/services/organization';
import { errorText } from '../../../../lib/errorText';
import { useActiveOrganization } from '../hooks/useOrganization';
import { SettingsSubsection } from './SettingsSubsection';
import { InviteDialog } from './team/InviteDialog';
import { JoinLinks } from './team/JoinLinks';
import { MemberRow } from './team/MemberRow';
import { PendingInvitations } from './team/PendingInvitations';

/**
 * Settings › Команда: the members with their roles (admins change roles and remove people; the
 * owner stays as they are), invitations by email (a link to copy, with a role), and join links.
 */
export function TeamSection() {
  const { t } = useTranslation('settings');
  const { auth, organization, available, userId } = useActiveOrganization();
  const [inviting, setInviting] = useState(false);
  const manage = useCan('members.manage');
  const manageJoinLinks = useCan('join-links.manage');

  if (auth.isPending || (available && organization.isPending)) {
    return (
      <SettingsSubsection scope="org" title={t('team.members.title')}>
        <SettingsContainer>
          <SettingsSkeleton label={t('team.members.title')} rows={3} variant="item" />
        </SettingsContainer>
      </SettingsSubsection>
    );
  }
  if (!available) return <Notice variant="info">{t('organization.unavailable')}</Notice>;
  if (organization.isError || !organization.data) {
    return (
      <Notice variant="destructive" role="alert">
        {t('organization.loadFailed', { message: errorText(organization.error) })}
      </Notice>
    );
  }

  const org = organization.data;

  return (
    <div className="flex flex-col gap-8">
      <SettingsSubsection scope="org" title={t('team.members.title')} description={t('organization.members.description')}>
        <SettingsContainer>
          <SettingsListHeader
            action={
              manage ? (
                <Button size="sm" onClick={() => setInviting(true)}>
                  {t('team.invite.button')}
                </Button>
              ) : undefined
            }
          >
            {t('team.members.count', { count: org.members.length })}
          </SettingsListHeader>
          {org.members.map(member => (
            <MemberRow key={member.id} member={member} organization={org} isYou={member.userId === userId} manage={manage} />
          ))}
        </SettingsContainer>
      </SettingsSubsection>
      {inviting ? <InviteDialog organizationId={org.id} onClose={() => setInviting(false)} /> : null}
      {manage ? <PendingInvitations invitations={org.invitations.filter(invitation => isOpenInvitation(invitation))} /> : null}
      {manageJoinLinks ? <JoinLinks organizationId={org.id} /> : null}
    </div>
  );
}
