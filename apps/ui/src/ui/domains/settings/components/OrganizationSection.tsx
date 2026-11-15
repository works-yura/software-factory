import { AlertDialog } from '@mastra/playground-ui/components/AlertDialog';
import { Badge } from '@mastra/playground-ui/components/Badge';
import { Button } from '@mastra/playground-ui/components/Button';
import { CopyInput } from '@mastra/playground-ui/components/CopyInput';
import { Input } from '@mastra/playground-ui/components/Input';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { Skeleton } from '@mastra/playground-ui/components/Skeleton';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { SettingsContainer, SettingsRow } from '@mastra/playground-ui/new/settings';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LogOut } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { useApiConfig } from '../../../../api/config';
import { queryKeys } from '../../../../api/keys';
import { useCan } from '../../../../hooks/useCan';
import { useFactoryAuth } from '../../../../hooks/useFactoryAuth';
import {
  getOrganization,
  leaveOrganization,
  listOrganizations,
  reloadIntoOrganization,
  setActiveOrganization,
  updateOrganization,
} from '../../auth/services/organization';
import type { FullOrganization } from '../../auth/services/organization';
import { SettingsSubsection } from './SettingsSubsection';
import { AvatarPicker } from './team/AvatarPicker';
import { RoleBadge } from './team/roles';

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The organization the person works in, active in their session: its id, and whether auth offers organizations. */
export function useActiveOrganization() {
  const { baseUrl } = useApiConfig();
  const auth = useFactoryAuth();
  const organizationId = auth.data?.user?.organizationId;
  const userId = auth.data?.user?.userId;
  const available = auth.data?.provider === 'better-auth' && Boolean(organizationId);
  const organization = useQuery({
    queryKey: queryKeys.organization(organizationId),
    queryFn: () => {
      if (!organizationId) throw new Error('No active organization to load');
      return getOrganization(baseUrl, organizationId);
    },
    enabled: available,
  });
  const me = organization.data?.members.find(member => member.userId === userId);
  return { auth, organization, available, userId, me };
}

function OrganizationName({ organization, editable }: { organization: FullOrganization; editable: boolean }) {
  const { t } = useTranslation('settings');
  const { baseUrl } = useApiConfig();
  const queryClient = useQueryClient();
  const [name, setName] = useState(organization.name);
  const rename = useMutation({
    mutationFn: (next: string) => updateOrganization(baseUrl, organization.id, { name: next }),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.organization(organization.id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.organizations() }),
      ]),
  });
  const trimmed = name.trim();
  const changed = trimmed !== '' && trimmed !== organization.name;

  if (!editable) {
    return (
      <Txt as="span" variant="body" data-testid="organization-name">
        {organization.name}
      </Txt>
    );
  }
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (changed) rename.mutate(trimmed);
  };
  return (
    <form onSubmit={submit} className="flex flex-col items-end gap-2">
      <div className="flex items-center gap-2">
        <Input
          size="sm"
          aria-label={t('organization.details.nameLabel')}
          data-testid="organization-name-input"
          value={name}
          maxLength={80}
          onChange={event => setName(event.target.value)}
        />
        <Button type="submit" size="sm" variant="primary" disabled={!changed || rename.isPending}>
          {rename.isPending ? t('organization.details.saving') : t('organization.details.save')}
        </Button>
      </div>
      {rename.isError ? (
        <Notice variant="destructive" role="alert">
          {t('organization.actionFailed', { message: errorText(rename.error) })}
        </Notice>
      ) : null}
    </form>
  );
}

function LeaveOrganization({ organization, isOwner }: { organization: FullOrganization; isOwner: boolean }) {
  const { t } = useTranslation('settings');
  const { baseUrl } = useApiConfig();
  const leave = useMutation({
    mutationFn: () => leaveOrganization(baseUrl, organization.id),
    onSuccess: () => reloadIntoOrganization(),
  });

  return (
    <SettingsSubsection scope="org" title={t('organization.danger.title')}>
      <SettingsContainer>
        <SettingsRow
          label={t('organization.danger.leaveTitle')}
          description={isOwner ? t('organization.danger.ownerCannotLeave') : t('organization.danger.leaveDescription')}
        >
          {isOwner ? null : (
            <AlertDialog>
              <AlertDialog.Trigger
                render={
                  <Button size="sm" variant="destructive" disabled={leave.isPending}>
                    <LogOut size={14} />
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
        {leave.isError ? (
          <div className="p-4">
            <Notice variant="destructive" role="alert">
              {t('organization.actionFailed', { message: errorText(leave.error) })}
            </Notice>
          </div>
        ) : null}
      </SettingsContainer>
    </SettingsSubsection>
  );
}

function OrganizationSwitcher({ activeId }: { activeId: string }) {
  const { t } = useTranslation('settings');
  const { baseUrl } = useApiConfig();
  const organizations = useQuery({
    queryKey: queryKeys.organizations(),
    queryFn: () => listOrganizations(baseUrl),
  });
  const switchTo = useMutation({
    mutationFn: (organizationId: string) => setActiveOrganization(baseUrl, organizationId),
    onSuccess: () => reloadIntoOrganization(),
  });

  if (organizations.isError) {
    return (
      <SettingsSubsection title={t('organization.switcher.title')}>
        <Notice variant="destructive" role="alert">
          {t('organization.switcher.loadFailed', { message: errorText(organizations.error) })}
        </Notice>
      </SettingsSubsection>
    );
  }
  // One organization (or the list still loading): nothing to switch to.
  if (!organizations.data || organizations.data.length < 2) return null;

  return (
    <SettingsSubsection title={t('organization.switcher.title')} description={t('organization.switcher.description')}>
      <SettingsContainer>
        {organizations.data.map(organization => (
          <SettingsRow key={organization.id} label={organization.name}>
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
          </SettingsRow>
        ))}
        {switchTo.isError ? (
          <div className="p-4">
            <Notice variant="destructive" role="alert">
              {t('organization.actionFailed', { message: errorText(switchTo.error) })}
            </Notice>
          </div>
        ) : null}
      </SettingsContainer>
    </SettingsSubsection>
  );
}

/**
 * Settings › Організація: the organization you work in — its name, ID and avatar (admins edit them),
 * your role, the organizations you can switch to, and leaving it. Members, invitations and join
 * links are in Settings › Команда. Everything goes through better-auth's endpoints, which enforce
 * who may do what.
 */
export function OrganizationSection() {
  const { t } = useTranslation('settings');
  const { baseUrl } = useApiConfig();
  const queryClient = useQueryClient();
  const { auth, organization, available, me } = useActiveOrganization();
  const manage = useCan('org.manage');
  const onlyReads = !useCan('card.write');

  if (auth.isPending || (available && organization.isPending)) {
    return (
      <SettingsSubsection scope="org" title={t('organization.details.title')}>
        <SettingsContainer>
          <SettingsRow label={t('organization.details.name')}>
            <Skeleton className="h-4 w-40" />
          </SettingsRow>
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
      <SettingsSubsection
        scope="org"
        title={t('organization.details.title')}
        description={t('organization.details.description')}
      >
        <SettingsContainer>
          <SettingsRow label={t('organization.details.name')} description={t('organization.details.nameDescription')}>
            {/* Keyed by the stored name, so a rename elsewhere resets the field. */}
            <OrganizationName key={org.name} organization={org} editable={manage} />
          </SettingsRow>
          <SettingsRow label={t('organization.details.id')} description={t('organization.details.idDescription')}>
            <CopyInput value={org.id} label={t('organization.details.id')} copyLabel={t('organization.details.copyId')} />
          </SettingsRow>
          <SettingsRow label={t('organization.details.avatar')} description={t('organization.details.avatarDescription')}>
            <AvatarPicker
              name={org.name}
              src={org.logo}
              editable={manage}
              onChange={async logo => {
                await updateOrganization(baseUrl, org.id, { logo });
                await Promise.all([
                  queryClient.invalidateQueries({ queryKey: queryKeys.organization(org.id) }),
                  queryClient.invalidateQueries({ queryKey: queryKeys.organizations() }),
                ]);
              }}
            />
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
