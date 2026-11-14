import { AlertDialog } from '@mastra/playground-ui/components/AlertDialog';
import { Badge } from '@mastra/playground-ui/components/Badge';
import type { BadgeVariant } from '@mastra/playground-ui/components/Badge';
import { Button } from '@mastra/playground-ui/components/Button';
import { CopyButton } from '@mastra/playground-ui/components/CopyButton';
import { Input } from '@mastra/playground-ui/components/Input';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { Skeleton } from '@mastra/playground-ui/components/Skeleton';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { SettingsContainer, SettingsRow } from '@mastra/playground-ui/new/settings';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2, X } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { useApiConfig } from '../../../../api/config';
import { queryKeys } from '../../../../api/keys';
import { useFactoryAuth } from '../../../../hooks/useFactoryAuth';
import { useOrganizationsQuery, useSwitchOrganizationMutation } from '../../../../hooks/useOrganizations';
import {
  cancelInvitation,
  canManageMembers,
  getOrganization,
  invitationLink,
  inviteMember,
  isOpenInvitation,
  removeMember,
} from '../../auth/services/organization';
import type {
  FullOrganization,
  OrganizationInvitation,
  OrganizationMember,
  OrganizationRole,
} from '../../auth/services/organization';
import { SettingsSubsection } from './SettingsSubsection';

const ROLE_BADGE: Record<OrganizationRole, BadgeVariant> = { owner: 'purple', admin: 'info', member: 'neutral' };

function RoleBadge({ role }: { role: OrganizationRole }) {
  const { t } = useTranslation('settings');
  return (
    <Badge size="sm" variant={ROLE_BADGE[role]}>
      {t(`organization.roles.${role}`)}
    </Badge>
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function MemberRow({
  member,
  organization,
  isYou,
  canRemove,
}: {
  member: OrganizationMember;
  organization: FullOrganization;
  isYou: boolean;
  canRemove: boolean;
}) {
  const { t } = useTranslation('settings');
  const { baseUrl } = useApiConfig();
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: () => removeMember(baseUrl, organization.id, member.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.organization(organization.id) }),
  });
  const name = member.user.name || member.user.email;

  return (
    <SettingsRow label={isYou ? t('organization.members.you', { name }) : name} description={member.user.email}>
      <div className="flex items-center gap-2">
        <RoleBadge role={member.role} />
        {canRemove ? (
          <AlertDialog>
            <AlertDialog.Trigger
              render={
                <Button
                  size="sm"
                  variant="destructive-ghost"
                  disabled={remove.isPending}
                  aria-label={t('organization.members.removeNamed', { name })}
                >
                  <Trash2 size={14} />
                  {t('organization.members.remove')}
                </Button>
              }
            />
            <AlertDialog.Content>
              <AlertDialog.Header>
                <AlertDialog.Title>
                  {t('organization.members.confirmTitle', { name, organization: organization.name })}
                </AlertDialog.Title>
                <AlertDialog.Description>{t('organization.members.confirmDescription')}</AlertDialog.Description>
              </AlertDialog.Header>
              <AlertDialog.Footer>
                <AlertDialog.Cancel>{t('organization.members.cancel')}</AlertDialog.Cancel>
                <AlertDialog.Action onClick={() => remove.mutate()}>{t('organization.members.remove')}</AlertDialog.Action>
              </AlertDialog.Footer>
            </AlertDialog.Content>
          </AlertDialog>
        ) : null}
      </div>
      {remove.isError ? (
        <Notice variant="destructive" role="alert">
          {t('organization.actionFailed', { message: errorText(remove.error) })}
        </Notice>
      ) : null}
    </SettingsRow>
  );
}

function InviteForm({ organizationId }: { organizationId: string }) {
  const { t } = useTranslation('settings');
  const { baseUrl } = useApiConfig();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const invite = useMutation({
    mutationFn: (address: string) => inviteMember(baseUrl, organizationId, address),
    onSuccess: () => {
      setEmail('');
      return queryClient.invalidateQueries({ queryKey: queryKeys.organization(organizationId) });
    },
  });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const address = email.trim();
    if (address) invite.mutate(address);
  };

  const created = invite.data;

  return (
    <SettingsContainer>
      <form onSubmit={submit}>
        <SettingsRow label={t('organization.invite.email')}>
          <div className="flex items-center gap-2">
            <Input
              type="email"
              size="sm"
              required
              aria-label={t('organization.invite.email')}
              placeholder={t('organization.invite.emailPlaceholder')}
              value={email}
              onChange={event => setEmail(event.target.value)}
            />
            <Button type="submit" variant="primary" size="sm" disabled={invite.isPending || !email.trim()}>
              {invite.isPending ? t('organization.invite.creating') : t('organization.invite.create')}
            </Button>
          </div>
        </SettingsRow>
      </form>
      {created ? (
        <SettingsRow label={t('organization.invite.created', { email: created.email })}>
          <div className="flex min-w-0 items-center gap-1">
            <Txt as="span" variant="caption" font="mono" className="truncate" data-testid="invitation-link">
              {invitationLink(created.id)}
            </Txt>
            <CopyButton content={invitationLink(created.id)} size="icon-sm" variant="ghost" tooltip={t('organization.invite.copy')} />
          </div>
        </SettingsRow>
      ) : null}
      {invite.isError ? (
        <div className="p-4">
          <Notice variant="destructive" role="alert">
            {t('organization.actionFailed', { message: errorText(invite.error) })}
          </Notice>
        </div>
      ) : null}
    </SettingsContainer>
  );
}

function PendingInvitationRow({ invitation }: { invitation: OrganizationInvitation }) {
  const { t, i18n } = useTranslation('settings');
  const { baseUrl } = useApiConfig();
  const queryClient = useQueryClient();
  const cancel = useMutation({
    mutationFn: () => cancelInvitation(baseUrl, invitation.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.organization(invitation.organizationId) }),
  });
  const expires = new Date(invitation.expiresAt).toLocaleDateString(i18n.language);

  return (
    <SettingsRow label={invitation.email} description={t('organization.pending.expires', { date: expires })}>
      <div className="flex items-center gap-1">
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
          <X size={14} />
          {t('organization.pending.cancel')}
        </Button>
      </div>
      {cancel.isError ? (
        <Notice variant="destructive" role="alert">
          {t('organization.actionFailed', { message: errorText(cancel.error) })}
        </Notice>
      ) : null}
    </SettingsRow>
  );
}

function OrganizationSwitcher({ activeId }: { activeId: string }) {
  const { t } = useTranslation('settings');
  const organizations = useOrganizationsQuery();
  const switchTo = useSwitchOrganizationMutation();

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
 * Settings › Організація: the organization you work in, its members, invitation links (owner and
 * admin only) and the organizations you can switch to. Everything goes through better-auth's own
 * organization endpoints, which enforce who may do what.
 */
export function OrganizationSection() {
  const { t } = useTranslation('settings');
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
  const me = org.members.find(member => member.userId === userId);
  const manage = canManageMembers(me?.role);
  const pending = org.invitations.filter(invitation => isOpenInvitation(invitation));

  return (
    <div className="flex flex-col gap-8">
      <SettingsSubsection
        scope="org"
        title={t('organization.details.title')}
        description={t('organization.details.description')}
      >
        <SettingsContainer>
          <SettingsRow label={t('organization.details.name')}>
            <Txt as="span" variant="body" data-testid="organization-name">
              {org.name}
            </Txt>
          </SettingsRow>
          {me ? (
            <SettingsRow label={t('organization.details.yourRole')}>
              <RoleBadge role={me.role} />
            </SettingsRow>
          ) : null}
        </SettingsContainer>
      </SettingsSubsection>

      <SettingsSubsection scope="org" title={t('organization.members.title')} description={t('organization.members.description')}>
        <SettingsContainer>
          {org.members.map(member => (
            <MemberRow
              key={member.id}
              member={member}
              organization={org}
              isYou={member.userId === userId}
              // The owner (the organization's author) cannot be removed, nor can you remove yourself here.
              canRemove={manage && member.role !== 'owner' && member.userId !== userId}
            />
          ))}
        </SettingsContainer>
      </SettingsSubsection>

      {manage ? (
        <>
          <SettingsSubsection scope="org" title={t('organization.invite.title')} description={t('organization.invite.description')}>
            <InviteForm organizationId={org.id} />
          </SettingsSubsection>
          <SettingsSubsection scope="org" title={t('organization.pending.title')}>
            <SettingsContainer>
              {pending.length === 0 ? (
                <SettingsRow label={t('organization.pending.empty')} />
              ) : (
                pending.map(invitation => <PendingInvitationRow key={invitation.id} invitation={invitation} />)
              )}
            </SettingsContainer>
          </SettingsSubsection>
        </>
      ) : null}

      <OrganizationSwitcher activeId={org.id} />
    </div>
  );
}
