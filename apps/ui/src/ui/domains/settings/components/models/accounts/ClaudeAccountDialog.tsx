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
import { accountErrorMessage, CLAUDE_ACCOUNTS_PROVIDER } from './accountErrors';

/** Rename a Claude Code account; accounts are added only by signing in to Claude. */
export function ClaudeAccountDialog({ account, onClose }: { account: CredentialAccountInfo; onClose: () => void }) {
  const { t } = useTranslation('settings');
  const mutation = useUpdateCredentialAccount(CLAUDE_ACCOUNTS_PROVIDER);
  const [label, setLabel] = useState(account.label);

  const ready = label.trim() !== '';
  const error = mutation.error ? accountErrorMessage(mutation.error) : undefined;

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
          <DialogTitle>{t('claudeAccounts.dialog.renameTitle', { label: account.label })}</DialogTitle>
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
          <DialogCancel>{t('claudeAccounts.dialog.cancel')}</DialogCancel>
          <DialogAction disabled={!ready} onConfirm={() => void save()}>
            {mutation.isPending ? t('claudeAccounts.dialog.saving') : t('claudeAccounts.dialog.save')}
          </DialogAction>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
