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
import { Txt } from '@mastra/playground-ui/components/Txt';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { CredentialAccountInfo } from '../../../../../../api/types';
import { useAddCredentialAccount, useUpdateCredentialAccount } from '../../../../../../hooks/useCredentialAccounts';
import { accountErrorMessage, CLAUDE_ACCOUNTS_PROVIDER } from './accountErrors';

export type ClaudeAccountDialogMode =
  | { kind: 'add'; canAddOrgKeys: boolean }
  | { kind: 'rename'; account: CredentialAccountInfo }
  | { kind: 'replaceSecret'; account: CredentialAccountInfo };

/** Add an account, rename one, or replace its secret. */
export function ClaudeAccountDialog({ mode, onClose }: { mode: ClaudeAccountDialogMode; onClose: () => void }) {
  const { t } = useTranslation('settings');
  const addMutation = useAddCredentialAccount(CLAUDE_ACCOUNTS_PROVIDER);
  const updateMutation = useUpdateCredentialAccount(CLAUDE_ACCOUNTS_PROVIDER);
  const mutation = mode.kind === 'add' ? addMutation : updateMutation;
  const [label, setLabel] = useState(mode.kind === 'rename' ? mode.account.label : '');
  const [secret, setSecret] = useState('');

  const askLabel = mode.kind !== 'replaceSecret';
  const askSecret = mode.kind !== 'rename';
  const ready = (!askLabel || label.trim() !== '') && (!askSecret || secret.trim() !== '');
  const error = mutation.error ? accountErrorMessage(mutation.error) : undefined;

  const save = async () => {
    if (!ready || mutation.isPending) return;
    try {
      if (mode.kind === 'add') await addMutation.mutateAsync({ label: label.trim(), secret: secret.trim() });
      else if (mode.kind === 'rename') await updateMutation.mutateAsync({ id: mode.account.id, label: label.trim() });
      else await updateMutation.mutateAsync({ id: mode.account.id, secret: secret.trim() });
      onClose();
    } catch {}
  };

  const close = () => {
    if (!mutation.isPending) onClose();
  };

  const title =
    mode.kind === 'add'
      ? t('claudeAccounts.dialog.addTitle')
      : mode.kind === 'rename'
        ? t('claudeAccounts.dialog.renameTitle', { label: mode.account.label })
        : t('claudeAccounts.dialog.replaceTitle', { label: mode.account.label });

  return (
    <Dialog open onOpenChange={open => !open && close()} pending={mutation.isPending}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {askSecret && (
            <DialogDescription>
              {t('claudeAccounts.dialog.subscriptionHint')}{' '}
              {mode.kind === 'add' &&
                (mode.canAddOrgKeys ? t('claudeAccounts.dialog.orgKeyHint') : t('claudeAccounts.dialog.orgKeyAdminOnly'))}
            </DialogDescription>
          )}
        </DialogHeader>
        <DialogBody>
          <form
            className="flex flex-col gap-3"
            onSubmit={event => {
              event.preventDefault();
              void save();
            }}
          >
            {askLabel && (
              <Field className="gap-1">
                <FieldLabel>{t('claudeAccounts.dialog.label')}</FieldLabel>
                <Input
                  autoFocus
                  size="sm"
                  maxLength={100}
                  placeholder={t('claudeAccounts.dialog.labelPlaceholder')}
                  value={label}
                  disabled={mutation.isPending}
                  onChange={event => setLabel(event.target.value)}
                />
              </Field>
            )}
            {askSecret && (
              <Field className="gap-1">
                <FieldLabel>{t('claudeAccounts.dialog.secret')}</FieldLabel>
                <Input
                  autoFocus={!askLabel}
                  size="sm"
                  type="password"
                  autoComplete="off"
                  placeholder={t('claudeAccounts.dialog.secretPlaceholder')}
                  value={secret}
                  disabled={mutation.isPending}
                  onChange={event => setSecret(event.target.value)}
                />
              </Field>
            )}
            {/* Lets Enter submit from either field. */}
            <button type="submit" hidden />
            {error && (
              <Txt as="p" variant="caption" className="text-destructive-foreground" role="alert">
                {error}
              </Txt>
            )}
          </form>
        </DialogBody>
        <DialogFooter>
          <DialogCancel>{t('claudeAccounts.dialog.cancel')}</DialogCancel>
          <DialogAction disabled={!ready} onConfirm={() => void save()}>
            {mutation.isPending ? t('claudeAccounts.dialog.saving') : t('claudeAccounts.dialog.save')}
          </DialogAction>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
