import { Avatar } from '@mastra/playground-ui/components/Avatar';
import { DropdownMenu } from '@mastra/playground-ui/components/DropdownMenu';
import { Sidebar, useSidebar } from '@mastra/playground-ui/components/Sidebar';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { AlertTriangle, Building2, ChevronsUpDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router';

import { useFactoryAuth } from '../../../../hooks/useFactoryAuth';
import { useOrganizationsQuery, useSwitchOrganizationMutation } from '../../../../hooks/useOrganizations';
import { settingsSectionPath } from '../../settings/settingsSections';

/**
 * The sidebar footer's organization row: the organization you work in, the others you can switch to
 * (with a check on the active one) and its settings. Only with better-auth sign-in, which is what has
 * organizations; a failed list says so in the menu rather than hiding the switch.
 */
export function SidebarOrganizationMenu() {
  const { t } = useTranslation('nav');
  const auth = useFactoryAuth();
  const { factoryId } = useParams<{ factoryId: string }>();
  const navigate = useNavigate();
  const { state: sidebarState, setOpenMobile } = useSidebar();
  const activeId = auth.data?.user?.organizationId;
  const available =
    Boolean(factoryId) && auth.data?.authenticated === true && auth.data.provider === 'better-auth' && Boolean(activeId);
  const organizations = useOrganizationsQuery({ enabled: available });
  const switchTo = useSwitchOrganizationMutation();

  if (!available || !factoryId || !activeId) return null;

  const active = organizations.data?.find(organization => organization.id === activeId);
  const name = active?.name ?? t('organization.fallbackName');
  const list = organizations.data ?? [];

  return (
    <DropdownMenu>
      <Sidebar.NavLink
        link={{ name, url: '' }}
        render={
          <DropdownMenu.Trigger
            render={<button type="button" />}
            aria-label={t('organization.menuFor', { name })}
          >
            <Avatar name={name} size="inline" />
            <Sidebar.NavLabel>
              <span className="flex min-w-0 flex-col text-left">
                <Txt as="span" variant="label" tone="ink" className="truncate">
                  {name}
                </Txt>
                <Txt as="span" variant="caption" tone="muted" className="truncate">
                  {t('organization.subtitle')}
                </Txt>
              </span>
            </Sidebar.NavLabel>
            {sidebarState !== 'collapsed' && <ChevronsUpDown aria-hidden="true" className="ml-auto" />}
          </DropdownMenu.Trigger>
        }
      />
      <DropdownMenu.Content align="start" side="top" className="w-64">
        {organizations.isError ? (
          <DropdownMenu.Item disabled role="alert">
            <AlertTriangle aria-hidden="true" />
            {t('organization.loadFailed', { message: errorText(organizations.error) })}
          </DropdownMenu.Item>
        ) : list.length > 1 ? (
          <>
            <DropdownMenu.Label>{t('organization.list')}</DropdownMenu.Label>
            <DropdownMenu.RadioOptions
              options={list.map(organization => ({ value: organization.id, label: organization.name }))}
              value={activeId}
              onValueChange={organizationId => {
                if (organizationId !== activeId) switchTo.mutate(organizationId);
              }}
            />
          </>
        ) : null}
        {switchTo.isError ? (
          <DropdownMenu.Item disabled role="alert">
            <AlertTriangle aria-hidden="true" />
            {t('organization.switchFailed', { message: errorText(switchTo.error) })}
          </DropdownMenu.Item>
        ) : null}
        {organizations.isError || list.length > 1 || switchTo.isError ? <DropdownMenu.Separator /> : null}
        <DropdownMenu.Item
          onClick={() => {
            setOpenMobile(false);
            void navigate(settingsSectionPath(factoryId, 'organization'));
          }}
        >
          <Building2 aria-hidden="true" />
          {t('organization.settings')}
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu>
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
