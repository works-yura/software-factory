import { Avatar } from '@mastra/playground-ui/components/Avatar';
import { DropdownMenu } from '@mastra/playground-ui/components/DropdownMenu';
import { Sidebar, useSidebar } from '@mastra/playground-ui/components/Sidebar';
import { Skeleton } from '@mastra/playground-ui/components/Skeleton';
import { ThemeToggle } from '@mastra/playground-ui/components/ThemeToggle';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { AlertTriangle, Building2, Check, ChevronsUpDown, LogOut, Settings2, UserCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useNavigate, useParams } from 'react-router';

import { useApiConfig } from '../../../../api/config';
import { errorText } from '../../../../lib/errorText';
import { useFactoryAuth } from '../../../../hooks/useFactoryAuth';
import { useOrganizationsQuery, useSwitchOrganizationMutation } from '../../../../hooks/useOrganizations';
import { useThemeOptions } from '../../../i18n/useThemeOptions';
import { useSettingsOpen } from '../../settings/hooks/useSettingsOpen';
import { settingsSectionPath } from '../../settings/settingsSections';
import type { SettingsSection } from '../../settings/settingsSections';
import { clearMastraCodeStorage, redirectToLogout } from '../services/auth';
import type { FactoryAuthState } from '../services/auth';
import { avatarSrc } from '../services/team';
import type { OrganizationSummary } from '../services/organization';

/** The footer trigger's id: closing settings returns focus here (`useCloseSettings`). */
const TRIGGER_ID = 'sidebar-settings-link';

/**
 * The sidebar footer: one row and one menu. Signed in, the row names the organization you work in
 * (or you, without organizations) and opens the account menu: your email, the theme, the organization
 * with the others to switch to, organization and profile settings, settings, and log out. Without a
 * signed-in account it is the settings link it always was.
 */
export function SidebarAccountMenu() {
  const auth = useFactoryAuth();
  const { factoryId } = useParams<{ factoryId: string }>();
  const { t } = useTranslation('nav');

  if (!factoryId) return null;

  if (auth.isLoading) {
    return (
      <Sidebar.NavLink
        role="status"
        aria-label={t('user.checkingSignIn')}
        render={
          <div aria-hidden className="pointer-events-none">
            <Skeleton className="size-icon-md shrink-0 rounded-full motion-reduce:before:animate-none" />
            <Sidebar.NavLabel>
              <Skeleton className="h-3 w-24 max-w-full motion-reduce:before:animate-none" />
            </Sidebar.NavLabel>
          </div>
        }
      />
    );
  }

  const account = auth.data;
  if (!account?.authEnabled || !account.authenticated) return <SettingsLink factoryId={factoryId} />;
  return <AccountMenu factoryId={factoryId} account={account} />;
}

/** Settings without an account: the plain link, as the footer had before the account menu. */
function SettingsLink({ factoryId }: { factoryId: string }) {
  const location = useLocation();
  const settingsOpen = useSettingsOpen();
  const { setOpenMobile } = useSidebar();
  const { t } = useTranslation('nav');
  const url = settingsSectionPath(factoryId, 'preferences');

  return (
    <Sidebar.NavLink
      link={{ name: t('user.settings'), url }}
      isActive={settingsOpen}
      render={
        <Link
          id={TRIGGER_ID}
          to={url}
          state={settingsOpen ? location.state : { from: location }}
          aria-label={t('user.settings')}
          onClick={() => setOpenMobile(false)}
        >
          <Settings2 aria-hidden="true" />
          <Sidebar.NavLabel>
            <Txt as="span" variant="label" tone="ink">
              {t('user.settings')}
            </Txt>
          </Sidebar.NavLabel>
        </Link>
      }
    />
  );
}

function AccountMenu({ factoryId, account }: { factoryId: string; account: FactoryAuthState }) {
  const { t } = useTranslation('nav');
  const { baseUrl } = useApiConfig();
  const navigate = useNavigate();
  const location = useLocation();
  const settingsOpen = useSettingsOpen();
  const { state: sidebarState, setOpenMobile } = useSidebar();
  const themeOptions = useThemeOptions();

  const user = account.user;
  const userName = user?.name?.trim() || user?.email || t('user.fallbackName');
  const activeOrganizationId = account.provider === 'better-auth' ? user?.organizationId : undefined;
  const organizations = useOrganizationsQuery({ enabled: Boolean(activeOrganizationId) });
  const switchTo = useSwitchOrganizationMutation();

  const activeOrganization = organizations.data?.find(organization => organization.id === activeOrganizationId);
  const organizationName = activeOrganization?.name ?? t('organization.fallbackName');
  // With organizations the row names the one you work in; without them, you.
  const triggerName = activeOrganizationId ? organizationName : userName;
  const triggerSubtitle = activeOrganizationId ? t('organization.subtitle') : user?.email;
  // The organization's avatar (its initial until an admin sets one), or yours without organizations.
  const organizationImage = avatarSrc(baseUrl, activeOrganization?.logo);
  const triggerImage = activeOrganizationId ? organizationImage : user?.avatarUrl;

  const openSettings = (section: SettingsSection) => {
    setOpenMobile(false);
    // Settings' "Back to app" returns where you were; reopening from settings keeps that origin.
    void navigate(settingsSectionPath(factoryId, section), { state: settingsOpen ? location.state : { from: location } });
  };

  const logOut = () => {
    clearMastraCodeStorage();
    redirectToLogout(baseUrl);
  };

  return (
    <DropdownMenu>
      <Sidebar.NavLink
        link={{ name: triggerName, url: '' }}
        isActive={settingsOpen}
        render={
          <DropdownMenu.Trigger
            id={TRIGGER_ID}
            render={<button type="button" />}
            aria-label={t('account.menuFor', { name: triggerName })}
          >
            <Avatar src={triggerImage} name={triggerName} size="inline" />
            <Sidebar.NavLabel>
              <span className="flex min-w-0 flex-col text-left">
                <Txt as="span" variant="label" tone="ink" className="truncate">
                  {triggerName}
                </Txt>
                {triggerSubtitle ? (
                  <Txt as="span" variant="caption" tone="muted" className="truncate">
                    {triggerSubtitle}
                  </Txt>
                ) : null}
              </span>
            </Sidebar.NavLabel>
            {sidebarState !== 'collapsed' && <ChevronsUpDown aria-hidden="true" className="ml-auto" />}
          </DropdownMenu.Trigger>
        }
      />
      <DropdownMenu.Content align="start" side="top" className="w-72">
        {user?.email ? <DropdownMenu.Label className="truncate">{user.email}</DropdownMenu.Label> : null}
        <div className="px-2 pb-1.5 pt-0.5">
          <ThemeToggle options={themeOptions} size="sm" aria-label={t('account.theme')} />
        </div>
        {activeOrganizationId ? (
          <>
            <DropdownMenu.Separator />
            <OrganizationRow
              activeId={activeOrganizationId}
              name={organizationName}
              image={organizationImage}
              organizations={organizations.data}
              loadError={organizations.isError ? organizations.error : undefined}
              switchError={switchTo.isError ? switchTo.error : undefined}
              onSwitch={organizationId => switchTo.mutate(organizationId)}
            />
          </>
        ) : null}
        <DropdownMenu.Separator />
        {activeOrganizationId ? (
          <DropdownMenu.Item onClick={() => openSettings('organization')}>
            <Building2 aria-hidden="true" />
            {t('organization.settings')}
          </DropdownMenu.Item>
        ) : null}
        <DropdownMenu.Item onClick={() => openSettings('account')}>
          <UserCircle aria-hidden="true" />
          {t('account.profileSettings')}
        </DropdownMenu.Item>
        <DropdownMenu.Item onClick={() => openSettings('preferences')}>
          <Settings2 aria-hidden="true" />
          {t('user.settings')}
        </DropdownMenu.Item>
        <DropdownMenu.Separator />
        <DropdownMenu.Item onClick={logOut}>
          <LogOut aria-hidden="true" />
          {t('account.logOut')}
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu>
  );
}

/**
 * The organization you work in. With others to switch to it opens "Organizations" (a check on the
 * active one); a failed list opens to say so instead of hiding the switch; with only one it is a row.
 */
function OrganizationRow({
  activeId,
  name,
  image,
  organizations,
  loadError,
  switchError,
  onSwitch,
}: {
  activeId: string;
  name: string;
  image: string | undefined;
  organizations: OrganizationSummary[] | undefined;
  loadError: unknown;
  switchError: unknown;
  onSwitch: (organizationId: string) => void;
}) {
  const { t } = useTranslation('nav');
  const { baseUrl } = useApiConfig();
  const label = (
    <>
      <Avatar src={image} name={name} size="inline" />
      <span className="flex min-w-0 flex-col">
        <span className="truncate">{name}</span>
        <Txt as="span" variant="caption" tone="muted" className="truncate">
          {t('organization.subtitle')}
        </Txt>
      </span>
    </>
  );
  const list = organizations ?? [];

  if (loadError === undefined && list.length <= 1 && switchError === undefined) {
    return (
      // Nothing to switch to: the organization you work in, as a labelled group rather than a dead item.
      <DropdownMenu.Group aria-label={t('organization.current', { name })}>
        <div className="flex min-w-0 items-center gap-2 px-2 py-1.5 text-sm">{label}</div>
      </DropdownMenu.Group>
    );
  }

  return (
    <DropdownMenu.Sub>
      <DropdownMenu.SubTrigger aria-label={t('organization.switchFrom', { name })}>{label}</DropdownMenu.SubTrigger>
      <DropdownMenu.SubContent className="w-64">
        <DropdownMenu.Label>{t('organization.list')}</DropdownMenu.Label>
        {loadError !== undefined ? (
          <DropdownMenu.Item disabled role="alert">
            <AlertTriangle aria-hidden="true" />
            {t('organization.loadFailed', { message: errorText(loadError) })}
          </DropdownMenu.Item>
        ) : (
          list.map(organization => (
            <DropdownMenu.Item
              key={organization.id}
              aria-current={organization.id === activeId ? 'true' : undefined}
              onClick={() => {
                if (organization.id !== activeId) onSwitch(organization.id);
              }}
            >
              <Avatar src={avatarSrc(baseUrl, organization.logo)} name={organization.name} size="inline" />
              <span className="truncate">{organization.name}</span>
              {organization.id === activeId ? <Check aria-hidden="true" className="ml-auto" /> : null}
            </DropdownMenu.Item>
          ))
        )}
        {switchError !== undefined ? (
          <DropdownMenu.Item disabled role="alert">
            <AlertTriangle aria-hidden="true" />
            {t('organization.switchFailed', { message: errorText(switchError) })}
          </DropdownMenu.Item>
        ) : null}
      </DropdownMenu.SubContent>
    </DropdownMenu.Sub>
  );
}
