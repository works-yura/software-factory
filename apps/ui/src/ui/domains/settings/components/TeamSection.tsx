import { AlertDialog } from '@mastra/playground-ui/components/AlertDialog';
import { Avatar } from '@mastra/playground-ui/components/Avatar';
import { Badge } from '@mastra/playground-ui/components/Badge';
import type { BadgeVariant } from '@mastra/playground-ui/components/Badge';
import { Button } from '@mastra/playground-ui/components/Button';
import { CopyButton } from '@mastra/playground-ui/components/CopyButton';
import {
  Dialog,
  DialogAction,
  DialogBody,
  DialogCancel,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@mastra/playground-ui/components/Dialog';
import { Field, FieldDescription, FieldLabel } from '@mastra/playground-ui/components/Field';
import { Input } from '@mastra/playground-ui/components/Input';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@mastra/playground-ui/components/Select';
import { Skeleton } from '@mastra/playground-ui/components/Skeleton';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { SettingsContainer, SettingsEmptyRow, SettingsListHeader, SettingsRow } from '@mastra/playground-ui/new/settings';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link2, Send, Trash2, X } from 'lucide-react';
import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { useApiConfig } from '../../../../api/config';
import { queryKeys } from '../../../../api/keys';
import {
  cancelInvitation,
  canManageMembers,
  invitationLink,
  inviteMember,
  isOpenInvitation,
  removeMember,
  updateMemberRole,
} from '../../auth/services/organization';
import type {
  AssignableRole,
  FullOrganization,
  OrganizationInvitation,
  OrganizationMember,
} from '../../auth/services/organization';
import {
  avatarSrc,
  createJoinLink,
  expiryToIso,
  joinLinkUrl,
  listJoinLinks,
  parseDomainList,
  revokeJoinLink,
} from '../../auth/services/team';
import type { JoinLink, JoinLinkExpiry, JoinLinkStatus } from '../../auth/services/team';
import { useActiveOrganization } from './OrganizationSection';
import { SettingsSubsection } from './SettingsSubsection';
import { RoleBadge, RoleSelect } from './team/roles';

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function useRefreshOrganization(organizationId: string) {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: queryKeys.organization(organizationId) });
}

function MemberRow({
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
  const refresh = useRefreshOrganization(organization.id);
  const remove = useMutation({
    mutationFn: () => removeMember(baseUrl, organization.id, member.id),
    onSuccess: refresh,
  });
  const changeRole = useMutation({
    mutationFn: (role: AssignableRole) => updateMemberRole(baseUrl, organization.id, member.id, role),
    onSuccess: refresh,
  });
  const name = member.user.name || member.user.email;
  // The owner keeps their role; admins change everyone else's, not their own (another admin can).
  const editable = manage && member.role !== 'owner' && !isYou;

  return (
    <SettingsRow
      label={
        <span className="flex items-center gap-2">
          <Avatar name={name} src={avatarSrc(baseUrl, member.user.image)} size="sm" />
          {isYou ? t('organization.members.you', { name }) : name}
        </span>
      }
      description={member.user.email}
    >
      <div className="flex items-center gap-2">
        {editable ? (
          <RoleSelect
            value={member.role as AssignableRole}
            label={t('team.members.roleOf', { name })}
            disabled={changeRole.isPending}
            onChange={role => {
              if (role !== member.role) changeRole.mutate(role);
            }}
          />
        ) : (
          <RoleBadge role={member.role} />
        )}
        {editable ? (
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
      {changeRole.isError ? (
        <Notice variant="destructive" role="alert">
          {t('team.members.roleFailed', { message: errorText(changeRole.error) })}
        </Notice>
      ) : null}
    </SettingsRow>
  );
}

/** Email and role; better-auth makes the invitation, Factory shows its link to copy (no email is sent). */
function InviteDialog({ organizationId, onClose }: { organizationId: string; onClose: () => void }) {
  const { t } = useTranslation('settings');
  const { baseUrl } = useApiConfig();
  const refresh = useRefreshOrganization(organizationId);
  const id = useId();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<AssignableRole>('member');
  const invite = useMutation({
    mutationFn: () => inviteMember(baseUrl, organizationId, email.trim(), role),
    onSuccess: refresh,
  });
  const created = invite.data;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (email.trim()) invite.mutate();
  };

  return (
    <Dialog open onOpenChange={next => !next && onClose()}>
      <DialogContent>
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{t('team.invite.title')}</DialogTitle>
            <DialogDescription>{t('team.invite.description')}</DialogDescription>
          </DialogHeader>
          <DialogBody className="flex flex-col gap-4">
            {created ? (
              <Field>
                <FieldLabel>{t('team.invite.created', { email: created.email, role: t(`organization.roles.${created.role}`) })}</FieldLabel>
                <div className="flex min-w-0 items-center gap-1">
                  <Txt as="span" variant="caption" font="mono" className="truncate" data-testid="invitation-link">
                    {invitationLink(created.id)}
                  </Txt>
                  <CopyButton content={invitationLink(created.id)} size="icon-sm" variant="ghost" tooltip={t('team.invite.copy')} />
                </div>
              </Field>
            ) : (
              <>
                <Field>
                  <FieldLabel htmlFor={`${id}-email`}>{t('team.invite.email')}</FieldLabel>
                  <Input
                    id={`${id}-email`}
                    type="email"
                    required
                    autoFocus
                    placeholder={t('organization.invite.emailPlaceholder')}
                    value={email}
                    onChange={event => setEmail(event.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel>{t('team.invite.role')}</FieldLabel>
                  <RoleSelect value={role} onChange={setRole} label={t('team.invite.role')} />
                </Field>
              </>
            )}
            {invite.isError ? (
              <Notice variant="destructive" role="alert">
                {t('organization.actionFailed', { message: errorText(invite.error) })}
              </Notice>
            ) : null}
          </DialogBody>
          <DialogFooter>
            {created ? (
              <DialogCancel>{t('team.invite.close')}</DialogCancel>
            ) : (
              <>
                <DialogCancel>{t('team.joinLinks.cancel')}</DialogCancel>
                <DialogAction type="submit" disabled={invite.isPending || !email.trim()}>
                  <Send size={14} />
                  {invite.isPending ? t('team.invite.creating') : t('team.invite.create')}
                </DialogAction>
              </>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function PendingInvitationRow({ invitation }: { invitation: OrganizationInvitation }) {
  const { t, i18n } = useTranslation('settings');
  const { baseUrl } = useApiConfig();
  const refresh = useRefreshOrganization(invitation.organizationId);
  const cancel = useMutation({ mutationFn: () => cancelInvitation(baseUrl, invitation.id), onSuccess: refresh });
  const expires = new Date(invitation.expiresAt).toLocaleDateString(i18n.language);

  return (
    <SettingsRow
      label={invitation.email}
      description={t('team.pending.role', { role: t(`organization.roles.${invitation.role}`), date: expires })}
    >
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

const EXPIRY_OPTIONS: JoinLinkExpiry[] = ['never', '1', '7', '30', 'custom'];

function CreateJoinLinkDialog({ organizationId, onClose }: { organizationId: string; onClose: () => void }) {
  const { t } = useTranslation('settings');
  const { baseUrl } = useApiConfig();
  const queryClient = useQueryClient();
  const id = useId();
  const [name, setName] = useState('');
  const [role, setRole] = useState<AssignableRole>('member');
  const [domains, setDomains] = useState('');
  const [expiry, setExpiry] = useState<JoinLinkExpiry>('never');
  const [customDate, setCustomDate] = useState('');
  const [maxUses, setMaxUses] = useState('');
  const create = useMutation({
    mutationFn: () =>
      createJoinLink(baseUrl, {
        organizationId,
        name: name.trim(),
        role,
        allowedDomains: parseDomainList(domains),
        expiresAt: expiryToIso(expiry, customDate),
        maxUses: maxUses.trim() ? Number(maxUses) : null,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.joinLinks(organizationId) });
      onClose();
    },
  });
  const maxUsesValid = maxUses.trim() === '' || (/^\d+$/.test(maxUses.trim()) && Number(maxUses) >= 1);
  const ready = name.trim() !== '' && maxUsesValid && (expiry !== 'custom' || customDate !== '');

  return (
    <Dialog open onOpenChange={next => !next && onClose()}>
      <DialogContent>
        <form
          onSubmit={event => {
            event.preventDefault();
            if (ready) create.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('team.joinLinks.dialogTitle')}</DialogTitle>
          </DialogHeader>
          <DialogBody className="flex flex-col gap-4">
            <Field>
              <FieldLabel htmlFor={`${id}-name`}>{t('team.joinLinks.name')}</FieldLabel>
              <Input
                id={`${id}-name`}
                autoFocus
                maxLength={80}
                placeholder={t('team.joinLinks.namePlaceholder')}
                value={name}
                onChange={event => setName(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel>{t('team.joinLinks.joinAs')}</FieldLabel>
              <RoleSelect value={role} onChange={setRole} label={t('team.joinLinks.joinAs')} />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-domains`}>{t('team.joinLinks.domains')}</FieldLabel>
              <Input
                id={`${id}-domains`}
                placeholder={t('team.joinLinks.domainsPlaceholder')}
                value={domains}
                onChange={event => setDomains(event.target.value)}
              />
              <FieldDescription>{t('team.joinLinks.domainsHint')}</FieldDescription>
            </Field>
            <Field>
              <FieldLabel>{t('team.joinLinks.expires')}</FieldLabel>
              <Select value={expiry} onValueChange={next => next && setExpiry(next as JoinLinkExpiry)}>
                <SelectTrigger size="sm" aria-label={t('team.joinLinks.expires')} className="w-full">
                  <Txt as="span" variant="caption">
                    {t(`team.joinLinks.expiry.${expiry}`)}
                  </Txt>
                </SelectTrigger>
                <SelectContent>
                  {EXPIRY_OPTIONS.map(option => (
                    <SelectItem key={option} value={option}>
                      {t(`team.joinLinks.expiry.${option}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            {expiry === 'custom' ? (
              <Field>
                <FieldLabel htmlFor={`${id}-date`}>{t('team.joinLinks.customDate')}</FieldLabel>
                <Input
                  id={`${id}-date`}
                  type="date"
                  min={new Date().toISOString().slice(0, 10)}
                  value={customDate}
                  onChange={event => setCustomDate(event.target.value)}
                />
              </Field>
            ) : null}
            <Field invalid={!maxUsesValid}>
              <FieldLabel htmlFor={`${id}-max`}>{t('team.joinLinks.maxUses')}</FieldLabel>
              <Input
                id={`${id}-max`}
                inputMode="numeric"
                placeholder="10"
                value={maxUses}
                onChange={event => setMaxUses(event.target.value)}
              />
              <FieldDescription>{t('team.joinLinks.maxUsesHint')}</FieldDescription>
            </Field>
            {create.isError ? (
              <Notice variant="destructive" role="alert">
                {t('organization.actionFailed', { message: errorText(create.error) })}
              </Notice>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <DialogCancel>{t('team.joinLinks.cancel')}</DialogCancel>
            <DialogAction type="submit" disabled={!ready || create.isPending}>
              {create.isPending ? t('team.joinLinks.creating') : t('team.joinLinks.create')}
            </DialogAction>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const STATUS_BADGE: Record<JoinLinkStatus, BadgeVariant> = {
  active: 'success',
  expired: 'neutral',
  revoked: 'neutral',
  used_up: 'neutral',
};

function JoinLinkRow({ link }: { link: JoinLink }) {
  const { t, i18n } = useTranslation('settings');
  const { baseUrl } = useApiConfig();
  const queryClient = useQueryClient();
  const revoke = useMutation({
    mutationFn: () => revokeJoinLink(baseUrl, link.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.joinLinks(link.organizationId) }),
  });
  const details = [
    t(`organization.roles.${link.role}`),
    link.maxUses === null
      ? t('team.joinLinks.uses_unlimited', { uses: link.uses })
      : t('team.joinLinks.uses_limited', { uses: link.uses, max: link.maxUses }),
    link.expiresAt
      ? t('team.joinLinks.expiresOn', { date: new Date(link.expiresAt).toLocaleDateString(i18n.language) })
      : t('team.joinLinks.neverExpires'),
    link.allowedDomains.length > 0 ? link.allowedDomains.join(', ') : t('team.joinLinks.anyDomain'),
  ].join(' · ');

  return (
    <SettingsRow
      label={
        <span className="flex items-center gap-2">
          <Link2 size={14} aria-hidden="true" />
          {link.name}
          <Badge size="sm" variant={STATUS_BADGE[link.status]}>
            {t(`team.joinLinks.status.${link.status}`)}
          </Badge>
        </span>
      }
      description={details}
    >
      {link.status === 'active' ? (
        <div className="flex items-center gap-1">
          <CopyButton
            content={joinLinkUrl(link.token)}
            size="icon-sm"
            variant="ghost"
            tooltip={t('team.joinLinks.copyNamed', { name: link.name })}
          />
          <Button
            size="sm"
            variant="ghost"
            disabled={revoke.isPending}
            aria-label={t('team.joinLinks.revokeNamed', { name: link.name })}
            onClick={() => revoke.mutate()}
          >
            <X size={14} />
            {t('team.joinLinks.revoke')}
          </Button>
        </div>
      ) : null}
      {revoke.isError ? (
        <Notice variant="destructive" role="alert">
          {t('organization.actionFailed', { message: errorText(revoke.error) })}
        </Notice>
      ) : null}
    </SettingsRow>
  );
}

function JoinLinks({ organizationId }: { organizationId: string }) {
  const { t } = useTranslation('settings');
  const { baseUrl } = useApiConfig();
  const [creating, setCreating] = useState(false);
  const links = useQuery({
    queryKey: queryKeys.joinLinks(organizationId),
    queryFn: () => listJoinLinks(baseUrl, organizationId),
  });
  const createButton = (
    <Button size="sm" onClick={() => setCreating(true)}>
      {t('team.joinLinks.create')}
    </Button>
  );

  return (
    <SettingsSubsection scope="org" title={t('team.joinLinks.title')} description={t('team.joinLinks.description')}>
      <SettingsContainer>
        {links.isPending ? (
          <SettingsRow label={<Skeleton className="h-4 w-40" />} />
        ) : links.isError ? (
          <div className="p-4">
            <Notice variant="destructive" role="alert">
              {t('team.joinLinks.loadFailed', { message: errorText(links.error) })}
            </Notice>
          </div>
        ) : links.data.length === 0 ? (
          <SettingsEmptyRow action={createButton}>{t('team.joinLinks.empty')}</SettingsEmptyRow>
        ) : (
          <>
            <SettingsListHeader action={createButton}>{t('team.joinLinks.title')}</SettingsListHeader>
            {links.data.map(link => (
              <JoinLinkRow key={link.id} link={link} />
            ))}
          </>
        )}
      </SettingsContainer>
      {creating ? <CreateJoinLinkDialog organizationId={organizationId} onClose={() => setCreating(false)} /> : null}
    </SettingsSubsection>
  );
}

/**
 * Settings › Команда: the members with their roles (admins change roles and remove people; the
 * owner stays as they are), invitations by email (a link to copy, with a role), and join links.
 */
export function TeamSection() {
  const { t } = useTranslation('settings');
  const { auth, organization, available, userId, me } = useActiveOrganization();
  const [inviting, setInviting] = useState(false);

  if (auth.isPending || (available && organization.isPending)) {
    return (
      <SettingsSubsection scope="org" title={t('team.members.title')}>
        <SettingsContainer>
          <SettingsRow label={<Skeleton className="h-4 w-40" />} />
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
  const manage = canManageMembers(me?.role);
  const pending = org.invitations.filter(invitation => isOpenInvitation(invitation));

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

      {manage ? (
        <>
          <SettingsSubsection scope="org" title={t('organization.pending.title')}>
            <SettingsContainer>
              {pending.length === 0 ? (
                <SettingsRow label={t('organization.pending.empty')} />
              ) : (
                pending.map(invitation => <PendingInvitationRow key={invitation.id} invitation={invitation} />)
              )}
            </SettingsContainer>
          </SettingsSubsection>
          <JoinLinks organizationId={org.id} />
        </>
      ) : null}
    </div>
  );
}
