import { CopyInput } from '@mastra/playground-ui/components/CopyInput';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { SettingsContainer, SettingsRow, SettingsSkeleton } from '@mastra/playground-ui/new/settings';
import { useTranslation } from 'react-i18next';

import { useCan } from '../../../../hooks/useCan';
import { errorText } from '../../../../lib/errorText';
import { useActiveOrganization, useUpdateOrganization } from '../hooks/useOrganization';
import { LeaveOrganization } from './organization/LeaveOrganization';
import { OrganizationName } from './organization/OrganizationName';
import { OrganizationSwitcher } from './organization/OrganizationSwitcher';
import { SettingsSubsection } from './SettingsSubsection';
import { AvatarPicker } from './team/AvatarPicker';
import { RoleBadge } from './team/roles';

/**
 * Settings › Організація: the organization you work in — its name, ID and avatar (admins edit them),
 * your role, the organizations you can switch to, and leaving it. Members, invitations and join
 * links are in Settings › Команда. Everything goes through better-auth's endpoints, which enforce
 * who may do what.
 */
export function OrganizationSection() {
  const { t } = useTranslation('settings');
  const { auth, organization, available, me } = useActiveOrganization();
  const manage = useCan('org.manage');
  const onlyReads = !useCan('card.write');
  const update = useUpdateOrganization(organization.data?.id ?? '');

  if (auth.isPending || (available && organization.isPending)) {
    return (
      <SettingsSubsection scope="org" title={t('organization.details.title')}>
        <SettingsContainer>
          <SettingsSkeleton label={t('organization.details.title')} rows={3} />
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
      {onlyReads ? <Notice variant="info">{t('organization.viewerNote')}</Notice> : null}
      <SettingsSubsection scope="org" title={t('organization.details.title')} description={t('organization.details.description')}>
        <SettingsContainer>
          <SettingsRow label={t('organization.details.name')} description={t('organization.details.nameDescription')}>
            {/* Keyed by the stored name, so a rename elsewhere resets the field. */}
            <OrganizationName key={org.name} organization={org} editable={manage} />
          </SettingsRow>
          <SettingsRow label={t('organization.details.id')} description={t('organization.details.idDescription')}>
            <CopyInput value={org.id} label={t('organization.details.id')} copyLabel={t('organization.details.copyId')} />
          </SettingsRow>
          <SettingsRow label={t('organization.details.avatar')} description={t('organization.details.avatarDescription')}>
            <AvatarPicker name={org.name} src={org.logo} editable={manage} onChange={logo => update.mutateAsync({ logo })} />
          </SettingsRow>
          {me ? (
            <SettingsRow label={t('organization.details.yourRole')}>
              <RoleBadge role={me.role} />
            </SettingsRow>
          ) : null}
        </SettingsContainer>
      </SettingsSubsection>

      <OrganizationSwitcher activeId={org.id} />

      <LeaveOrganization organization={org} isOwner={me?.role === 'owner'} />
    </div>
  );
}
