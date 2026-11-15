import { AlertDialog } from '@mastra/playground-ui/components/AlertDialog';
import { Button } from '@mastra/playground-ui/components/Button';
import { SettingsContainer, SettingsRow } from '@mastra/playground-ui/new/settings';
import { LogOut } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { FullOrganization } from '../../../auth/services/organization';
import { errorText } from '../../../../../lib/errorText';
import { useLeaveOrganization } from '../../hooks/useOrganization';
import { SettingsSubsection } from '../SettingsSubsection';

/** Leaving the organization: the person's own choice, so a personal setting; the owner cannot. */
export function LeaveOrganization({ organization, isOwner }: { organization: FullOrganization; isOwner: boolean }) {
  const { t } = useTranslation('settings');
  const leave = useLeaveOrganization(organization.id);

  return (
    <SettingsSubsection scope="personal" title={t('organization.danger.title')}>
      <SettingsContainer>
        <SettingsRow
          label={t('organization.danger.leaveTitle')}
          description={isOwner ? t('organization.danger.ownerCannotLeave') : t('organization.danger.leaveDescription')}
          errorMsg={leave.isError ? t('organization.actionFailed', { message: errorText(leave.error) }) : undefined}
        >
          {isOwner ? null : (
            <AlertDialog>
              <AlertDialog.Trigger
                render={
                  <Button size="sm" variant="destructive" disabled={leave.isPending}>
                    <LogOut aria-hidden="true" />
                    {leave.isPending ? t('organization.danger.leaving') : t('organization.danger.leave')}
                  </Button>
                }
              />
              <AlertDialog.Content>
                <AlertDialog.Header>
                  <AlertDialog.Title>{t('organization.danger.confirmTitle', { organization: organization.name })}</AlertDialog.Title>
                  <AlertDialog.Description>{t('organization.danger.confirmDescription')}</AlertDialog.Description>
                </AlertDialog.Header>
                <AlertDialog.Footer>
                  <AlertDialog.Cancel>{t('organization.danger.cancel')}</AlertDialog.Cancel>
                  <AlertDialog.Action onClick={() => leave.mutate()}>{t('organization.danger.leave')}</AlertDialog.Action>
                </AlertDialog.Footer>
              </AlertDialog.Content>
            </AlertDialog>
          )}
        </SettingsRow>
      </SettingsContainer>
    </SettingsSubsection>
  );
}
