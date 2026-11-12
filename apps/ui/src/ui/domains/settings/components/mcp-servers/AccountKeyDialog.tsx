import { Button } from '@mastra/playground-ui/components/Button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@mastra/playground-ui/components/Dialog';
import { Input } from '@mastra/playground-ui/components/Input';
import { Textarea } from '@mastra/playground-ui/components/Textarea';
import { toast } from '@mastra/playground-ui/components/Toaster';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useAddGoogleCloudAccount } from '../../../../../hooks/useFirebase';
import type { FirebaseAccount } from '../../services/firebase';

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Paste or pick a service account key for an MCP server's account field (the MCP editor is the one
 * custom editor of Підключення, ADR-0035): a new Google Cloud account of the organization, sent
 * once and never shown again; the form then picks it.
 */
export function AccountKeyDialog({ onClose, onAdded }: { onClose: () => void; onAdded?: (account: FirebaseAccount) => void }) {
  const { t } = useTranslation('settings');
  const addAccount = useAddGoogleCloudAccount();
  const [keyJson, setKeyJson] = useState('');
  const [name, setName] = useState('');

  const save = () =>
    addAccount.mutate(
      { serviceAccountJson: keyJson, ...(name.trim() ? { name: name.trim() } : {}) },
      {
        onSuccess: result => {
          toast.success(t('observability.accounts.saved'));
          onAdded?.(result.account);
          onClose();
        },
        onError: error => toast.error(errorMessage(error)),
      },
    );

  return (
    <Dialog open onOpenChange={open => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('observability.key.addTitle')}</DialogTitle>
          <DialogDescription>{t('observability.key.roles')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          <Input
            aria-label={t('observability.key.nameLabel')}
            placeholder={t('observability.key.namePlaceholder')}
            value={name}
            onChange={event => setName(event.target.value)}
          />
          <Textarea
            aria-label={t('observability.key.keyLabel')}
            placeholder={t('observability.key.keyPlaceholder')}
            value={keyJson}
            rows={6}
            spellCheck={false}
            autoComplete="off"
            onChange={event => setKeyJson(event.target.value)}
          />
          <label className="cursor-pointer self-start">
            <input
              type="file"
              accept="application/json,.json"
              className="sr-only"
              aria-label={t('observability.key.pickFile')}
              onChange={async event => {
                const file = event.target.files?.[0];
                if (file) setKeyJson(await file.text());
              }}
            />
            <Txt as="span" variant="caption" tone="muted" className="underline">
              {t('observability.key.pickFile')}
            </Txt>
          </label>
        </DialogBody>
        <DialogFooter>
          <Button size="sm" variant="ghost" onClick={onClose}>
            {t('observability.cancel')}
          </Button>
          <Button size="sm" disabled={!keyJson.trim() || addAccount.isPending} onClick={save}>
            {t('observability.key.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
