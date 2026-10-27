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
import { Input } from '@mastra/playground-ui/components/Input';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { ProviderInfo } from '../../../../api/types';
import { useSaveProviderKey } from '../../../../hooks/use-providers';
import { providerDisplayName } from '@factory/credentials/provider-display-name';

interface AddApiKeyDialogProps {
  provider: ProviderInfo;
  authEnabled: boolean;
  onClose: () => void;
}

/** Dialog for adding or updating a provider API key; with auth enabled the key belongs to the organization. */
export function AddApiKeyDialog({ provider, authEnabled, onClose }: AddApiKeyDialogProps) {
  const { t } = useTranslation('settings');
  const displayName = providerDisplayName(provider.provider);
  const saveKeyMutation = useSaveProviderKey();
  const [keyDraft, setKeyDraft] = useState('');

  const replacesSignIn = authEnabled && provider.orgCredential === 'oauth';
  const error = saveKeyMutation.error instanceof Error ? saveKeyMutation.error.message : undefined;

  const saveKey = async () => {
    const key = keyDraft.trim();
    if (!key || saveKeyMutation.isPending) return;
    try {
      await saveKeyMutation.mutateAsync({
        provider: provider.provider,
        key,
        envVar: provider.envVar,
        ...(authEnabled ? { scope: 'org' as const } : {}),
      });
      onClose();
    } catch {}
  };

  const close = () => {
    if (!saveKeyMutation.isPending) onClose();
  };

  return (
    <Dialog open onOpenChange={open => !open && close()} pending={saveKeyMutation.isPending}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('apiKey.title', { name: displayName })}</DialogTitle>
          <DialogDescription>
            {t('apiKey.storedSecurely')}
            {authEnabled && ` ${t('apiKey.access.org')}`}
            {replacesSignIn && ` ${t('apiKey.replacesSignIn')}`}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <Input
            autoFocus
            type="password"
            aria-label={t('apiKey.title', { name: displayName })}
            placeholder={t('apiKey.placeholder')}
            value={keyDraft}
            disabled={saveKeyMutation.isPending}
            onChange={event => setKeyDraft(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') void saveKey();
              if (event.key === 'Escape') close();
            }}
          />
          {error && (
            <Txt as="p" variant="caption" className="text-destructive-foreground" role="alert">
              {error}
            </Txt>
          )}
        </DialogBody>
        <DialogFooter>
          <DialogCancel>{t('apiKey.cancel')}</DialogCancel>
          <DialogAction disabled={!keyDraft.trim()} onConfirm={() => void saveKey()}>
            {saveKeyMutation.isPending ? t('apiKey.saving') : t('apiKey.save')}
          </DialogAction>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
