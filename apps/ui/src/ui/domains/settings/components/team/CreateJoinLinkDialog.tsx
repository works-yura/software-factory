import {
  Dialog,
  DialogAction,
  DialogBody,
  DialogCancel,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@mastra/playground-ui/components/Dialog';
import { Field, FieldDescription, FieldLabel } from '@mastra/playground-ui/components/Field';
import { Input } from '@mastra/playground-ui/components/Input';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@mastra/playground-ui/components/Select';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { AssignableRole } from '../../../auth/services/organization';
import { expiryToIso, parseDomainList } from '../../../auth/services/team';
import type { JoinLinkExpiry } from '../../../auth/services/team';
import { errorText } from '../../../../../lib/errorText';
import { useCreateJoinLink } from '../../hooks/useJoinLinks';
import { RoleSelect } from './roles';

const EXPIRY_OPTIONS: JoinLinkExpiry[] = ['never', '1', '7', '30', 'custom'];

/** A join link: its name, the role it gives, which email domains may use it, when it expires, how many times. */
export function CreateJoinLinkDialog({ organizationId, onClose }: { organizationId: string; onClose: () => void }) {
  const { t } = useTranslation('settings');
  const id = useId();
  const [name, setName] = useState('');
  const [role, setRole] = useState<AssignableRole>('member');
  const [domains, setDomains] = useState('');
  const [expiry, setExpiry] = useState<JoinLinkExpiry>('never');
  const [customDate, setCustomDate] = useState('');
  const [maxUses, setMaxUses] = useState('');
  const create = useCreateJoinLink(organizationId);
  const maxUsesValid = maxUses.trim() === '' || (/^\d+$/.test(maxUses.trim()) && Number(maxUses) >= 1);
  const ready = name.trim() !== '' && maxUsesValid && (expiry !== 'custom' || customDate !== '');

  return (
    <Dialog open onOpenChange={next => !next && onClose()}>
      <DialogContent>
        <form
          onSubmit={event => {
            event.preventDefault();
            if (!ready) return;
            create.mutate(
              {
                name: name.trim(),
                role,
                allowedDomains: parseDomainList(domains),
                expiresAt: expiryToIso(expiry, customDate),
                maxUses: maxUses.trim() ? Number(maxUses) : null,
              },
              { onSuccess: onClose },
            );
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
              <RoleSelect value={role} onChange={setRole} label={t('team.joinLinks.joinAs')} fill />
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
