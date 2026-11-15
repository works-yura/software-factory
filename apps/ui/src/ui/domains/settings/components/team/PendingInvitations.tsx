import { Button } from '@mastra/playground-ui/components/Button';
import { CopyButton } from '@mastra/playground-ui/components/CopyButton';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { SettingsContainer, SettingsEmptyRow, SettingsItem, SettingsItemIcon } from '@mastra/playground-ui/new/settings';
import { Mail, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { invitationLink } from '../../../auth/services/organization';
import type { OrganizationInvitation } from '../../../auth/services/organization';
import { errorText } from '../../../../../lib/errorText';
import { useCancelInvitation } from '../../hooks/useOrganization';
import { SettingsSubsection } from '../SettingsSubsection';

function PendingInvitationRow({ invitation }: { invitation: OrganizationInvitation }) {
  const { t, i18n } = useTranslation('settings');
  const cancel = useCancelInvitation(invitation.organizationId, invitation.id);
  const expires = new Date(invitation.expiresAt).toLocaleDateString(i18n.language);

  return (
    <SettingsItem
      media={
        <SettingsItemIcon>
          <Mail />
        </SettingsItemIcon>
      }
      title={invitation.email}
      description={t('team.pending.role', { role: t(`organization.roles.${invitation.role}`), date: expires })}
      notice={
        cancel.isError ? (
          <Notice variant="destructive" role="alert">
            {t('organization.actionFailed', { message: errorText(cancel.error) })}
          </Notice>
        ) : null
      }
    >
      <CopyButton
        content={invitationLink(invitation.id)}
        size="icon-sm"
        variant="ghost"
        tooltip={t('organization.pending.copy', { email: invitation.email })}
      />
      <Button
        size="sm"
        variant="ghost"
        disabled={cancel.isPending}
        aria-label={t('organization.pending.cancelNamed', { email: invitation.email })}
        onClick={() => cancel.mutate()}
      >
        <X aria-hidden="true" />
        {t('organization.pending.cancel')}
      </Button>
    </SettingsItem>
  );
}

/** Invitations not yet accepted, each with its link to copy again and a way to cancel it. */
export function PendingInvitations({ invitations }: { invitations: OrganizationInvitation[] }) {
  const { t } = useTranslation('settings');
  return (
    <SettingsSubsection scope="org" title={t('organization.pending.title')}>
      <SettingsContainer>
        {invitations.length === 0 ? (
          <SettingsEmptyRow>{t('organization.pending.empty')}</SettingsEmptyRow>
        ) : (
          invitations.map(invitation => <PendingInvitationRow key={invitation.id} invitation={invitation} />)
        )}
      </SettingsContainer>
    </SettingsSubsection>
  );
}
