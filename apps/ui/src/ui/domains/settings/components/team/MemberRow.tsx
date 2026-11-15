import { AlertDialog } from '@mastra/playground-ui/components/AlertDialog';
import { Avatar } from '@mastra/playground-ui/components/Avatar';
import { Button } from '@mastra/playground-ui/components/Button';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { SettingsItem } from '@mastra/playground-ui/new/settings';
import { Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useApiConfig } from '../../../../../api/config';
import type { AssignableRole, FullOrganization, OrganizationMember } from '../../../auth/services/organization';
import { avatarSrc } from '../../../auth/services/team';
import { errorText } from '../../../../../lib/errorText';
import { useChangeMemberRole, useRemoveMember } from '../../hooks/useOrganization';
import { RoleBadge, RoleSelect } from './roles';

/**
 * One member: who they are, their role (a select for admins, a badge otherwise) and, for admins,
 * removing them. The owner keeps their role; admins change everyone else's, not their own.
 */
export function MemberRow({
  member,
  organization,
  isYou,
  manage,
}: {
  member: OrganizationMember;
  organization: FullOrganization;
  isYou: boolean;
  manage: boolean;
}) {
  const { t } = useTranslation('settings');
  const { baseUrl } = useApiConfig();
  const remove = useRemoveMember(organization.id, member.id);
  const changeRole = useChangeMemberRole(organization.id, member.id);
  const name = member.user.name || member.user.email;
  const editable = manage && member.role !== 'owner' && !isYou;
  const failure = remove.isError
    ? t('organization.actionFailed', { message: errorText(remove.error) })
    : changeRole.isError
      ? t('team.members.roleFailed', { message: errorText(changeRole.error) })
      : undefined;

  return (
    <SettingsItem
      media={<Avatar name={name} src={avatarSrc(baseUrl, member.user.image)} size="md" />}
      title={isYou ? t('organization.members.you', { name }) : name}
      description={member.user.email}
      notice={
        failure ? (
          <Notice variant="destructive" role="alert">
            {failure}
          </Notice>
        ) : null
      }
    >
      {editable ? (
        <>
          <RoleSelect
            value={member.role as AssignableRole}
            label={t('team.members.roleOf', { name })}
            disabled={changeRole.isPending}
            onChange={role => {
              if (role !== member.role) changeRole.mutate(role);
            }}
          />
          <AlertDialog>
            <AlertDialog.Trigger
              render={
                <Button
                  size="sm"
                  variant="destructive-ghost"
                  disabled={remove.isPending}
                  aria-label={t('organization.members.removeNamed', { name })}
                >
                  <Trash2 aria-hidden="true" />
                  {t('organization.members.remove')}
                </Button>
              }
            />
            <AlertDialog.Content>
              <AlertDialog.Header>
                <AlertDialog.Title>{t('organization.members.confirmTitle', { name, organization: organization.name })}</AlertDialog.Title>
                <AlertDialog.Description>{t('organization.members.confirmDescription')}</AlertDialog.Description>
              </AlertDialog.Header>
              <AlertDialog.Footer>
                <AlertDialog.Cancel>{t('organization.members.cancel')}</AlertDialog.Cancel>
                <AlertDialog.Action onClick={() => remove.mutate()}>{t('organization.members.remove')}</AlertDialog.Action>
              </AlertDialog.Footer>
            </AlertDialog.Content>
          </AlertDialog>
        </>
      ) : (
        <RoleBadge role={member.role} />
      )}
    </SettingsItem>
  );
}
