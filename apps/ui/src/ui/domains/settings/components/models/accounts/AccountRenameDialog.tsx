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
import { Field, FieldLabel } from '@mastra/playground-ui/components/Field';
import { Input } from '@mastra/playground-ui/components/Input';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { CredentialAccountInfo } from '../../../../../../api/types';
import { useUpdateCredentialAccount } from '../../../../../../hooks/useCredentialAccounts';
import { accountErrorMessage } from './accountErrors';
import type { HarnessAccounts } from './harnessAccounts';

/** Rename a harness's account; accounts are added only by signing in. */
export function AccountRenameDialog({
  accounts,
  account,
  onClose,
}: {
  accounts: HarnessAccounts;
  account: CredentialAccountInfo;
  onClose: () => void;
}) {
  const { t } = useTranslation('settings');
  const mutation = useUpdateCredentialAccount(accounts.provider);
  const [label, setLabel] = useState(account.label);

  const ready = label.trim() !== '';
  const error = mutation.error ? accountErrorMessage(mutation.error, accounts) : undefined;

  const save = async () => {
    if (!ready || mutation.isPending) return;
    try {
      await mutation.mutateAsync({ id: account.id, label: label.trim() });
      onClose();
    } catch {}
  };

  const close = () => {
    if (!mutation.isPending) onClose();
  };

  return (
    <Dialog open onOpenChange={open => !open && close()} pending={mutation.isPending}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('accounts.dialog.renameTitle', { label: account.label })}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <form
            className="flex flex-col gap-3"
            onSubmit={event => {
              event.preventDefault();
              void save();
            }}
          >
            <Field className="gap-1">
              <FieldLabel>{t('accounts.dialog.label')}</FieldLabel>
              <Input
                autoFocus
                size="sm"
                maxLength={100}
                placeholder={t(`accounts.harness.${accounts.i18nKey}.dialog.labelPlaceholder`)}
                value={label}
                disabled={mutation.isPending}
                onChange={event => setLabel(event.target.value)}
              />
            </Field>
            {/* Lets Enter submit. */}
            <button type="submit" hidden />
            {error && (
              <Txt as="p" variant="caption" className="text-destructive-foreground" role="alert">
                {error}
              </Txt>
            )}
          </form>
        </DialogBody>
        <DialogFooter>
          <DialogCancel>{t('accounts.dialog.cancel')}</DialogCancel>
          <DialogAction disabled={!ready} onConfirm={() => void save()}>
            {mutation.isPending ? t('accounts.dialog.saving') : t('accounts.dialog.save')}
          </DialogAction>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
