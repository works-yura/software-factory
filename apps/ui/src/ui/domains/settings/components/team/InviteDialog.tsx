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
import { Field, FieldLabel } from '@mastra/playground-ui/components/Field';
import { Input } from '@mastra/playground-ui/components/Input';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { Send } from 'lucide-react';
import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { invitationLink } from '../../../auth/services/organization';
import type { AssignableRole } from '../../../auth/services/organization';
import { errorText } from '../../../../../lib/errorText';
import { useInviteMember } from '../../hooks/useOrganization';
import { RoleSelect } from './roles';

/** Email and role; better-auth makes the invitation, Factory shows its link to copy (no email is sent). */
export function InviteDialog({ organizationId, onClose }: { organizationId: string; onClose: () => void }) {
  const { t } = useTranslation('settings');
  const id = useId();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<AssignableRole>('member');
  const invite = useInviteMember(organizationId);
  const created = invite.data;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (email.trim()) invite.mutate({ email: email.trim(), role });
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
                  <Txt as="span" variant="caption" font="mono" className="min-w-0 truncate" data-testid="invitation-link">
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
                  <RoleSelect value={role} onChange={setRole} label={t('team.invite.role')} fill />
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
                  <Send aria-hidden="true" />
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
