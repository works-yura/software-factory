import { Badge } from '@mastra/playground-ui/components/Badge';
import { Button } from '@mastra/playground-ui/components/Button';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { SettingsContainer, SettingsItem, SettingsItemIcon, SettingsNoticeRow } from '@mastra/playground-ui/new/settings';
import { Building2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useOrganizationsQuery, useSwitchOrganizationMutation } from '../../../../../hooks/useOrganizations';
import { errorText } from '../../../../../lib/errorText';
import { SettingsSubsection } from '../SettingsSubsection';

/** The organizations the person belongs to, with the active one marked; hidden while there is only one. */
export function OrganizationSwitcher({ activeId }: { activeId: string }) {
  const { t } = useTranslation('settings');
  const organizations = useOrganizationsQuery();
  const switchTo = useSwitchOrganizationMutation();

  if (organizations.isError) {
    return (
      <SettingsSubsection scope="personal" title={t('organization.switcher.title')}>
        <Notice variant="destructive" role="alert">
          {t('organization.switcher.loadFailed', { message: errorText(organizations.error) })}
        </Notice>
      </SettingsSubsection>
    );
  }
  // One organization (or the list still loading): nothing to switch to.
  if (!organizations.data || organizations.data.length < 2) return null;

  return (
    <SettingsSubsection scope="personal" title={t('organization.switcher.title')} description={t('organization.switcher.description')}>
      <SettingsContainer>
        {organizations.data.map(organization => (
          <SettingsItem
            key={organization.id}
            media={
              <SettingsItemIcon>
                <Building2 />
              </SettingsItemIcon>
            }
            title={organization.name}
          >
            {organization.id === activeId ? (
              <Badge size="sm" variant="success">
                {t('organization.switcher.current')}
              </Badge>
            ) : (
              <Button
                size="sm"
                disabled={switchTo.isPending}
                aria-label={t('organization.switcher.switchNamed', { name: organization.name })}
                onClick={() => switchTo.mutate(organization.id)}
              >
                {t('organization.switcher.switch')}
              </Button>
            )}
          </SettingsItem>
        ))}
        <SettingsNoticeRow>
          {switchTo.isError ? (
            <Notice variant="destructive" role="alert">
              {t('organization.actionFailed', { message: errorText(switchTo.error) })}
            </Notice>
          ) : null}
        </SettingsNoticeRow>
      </SettingsContainer>
    </SettingsSubsection>
  );
}
