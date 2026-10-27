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
import { SegmentedControl, SegmentedControlItem } from '@mastra/playground-ui/components/SegmentedControl';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { ProviderInfo } from '../../../../api/types';
import { useOrgKeyAdminQuery, useSaveProviderKey } from '../../../../hooks/use-providers';
import { providerDisplayName } from '@factory/credentials/provider-display-name';
import { lazyLabels } from '../../../i18n/lazy';

type KeyScope = 'user' | 'org';

const SCOPED_KEY_ACCESS: Readonly<Record<KeyScope, string>> = lazyLabels(
  ['org', 'user'] as const,
  scope => `settings:apiKey.access.${scope}`,
);

interface AddApiKeyDialogProps {
  provider: ProviderInfo;
  authEnabled: boolean;
  /**
   * Scope preselected when the dialog opens. Shared contexts (factory setup)
   * pass `'org'` so the whole team can use the key; personal settings keep the
   * `'user'` default. An existing org key always wins so edits don't silently
   * narrow a shared key.
   */
  defaultScope?: KeyScope;
  fixedScope?: KeyScope;
  onClose: () => void;
}

/** Dialog for adding or updating a provider API key, with an org/user scope choice when auth is enabled. */
export function AddApiKeyDialog({
  provider,
  authEnabled,
  defaultScope = 'user',
  fixedScope,
  onClose,
}: AddApiKeyDialogProps) {
  const { t } = useTranslation('settings');
  const displayName = providerDisplayName(provider.provider);
  const saveKeyMutation = useSaveProviderKey();
  const orgKeyAdminQuery = useOrgKeyAdminQuery();
  const canWriteOrgKey = !authEnabled || (orgKeyAdminQuery.data ?? true);
  const preferredScope = provider.source === 'stored-org' ? 'org' : defaultScope;
  const [keyDraft, setKeyDraft] = useState('');
  const [chosenScope, setChosenScope] = useState<KeyScope>();
  const writableScope = canWriteOrgKey ? (chosenScope ?? preferredScope) : 'user';
  const scope: KeyScope = fixedScope ?? writableScope;

  const fixedScopeCredential = fixedScope === 'org' ? provider.orgCredential : provider.userCredential;
  const replacesSignIn = fixedScope !== undefined && fixedScopeCredential === 'oauth';
  const error = saveKeyMutation.error instanceof Error ? saveKeyMutation.error.message : undefined;
  const personalOnlyWarning = authEnabled && preferredScope === 'org' && !canWriteOrgKey;

  const saveKey = async () => {
    const key = keyDraft.trim();
    if (!key || saveKeyMutation.isPending) return;
    try {
      await saveKeyMutation.mutateAsync({
        provider: provider.provider,
        key,
        envVar: provider.envVar,
        ...(authEnabled ? { scope } : {}),
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
            {fixedScope && ` ${SCOPED_KEY_ACCESS[fixedScope]}`}
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
          {authEnabled && !fixedScope && (
            <div className="flex items-center justify-between gap-4">
              <Txt as="span" variant="caption" tone="muted">
                {t('apiKey.whoCanUse')}
              </Txt>
              <SegmentedControl
                aria-label={t('apiKey.accessLabel')}
                value={scope}
                onValueChange={setChosenScope}
                disabled={saveKeyMutation.isPending}
              >
                <SegmentedControlItem value="user">{t('apiKey.justMe')}</SegmentedControlItem>
                <SegmentedControlItem
                  value="org"
                  disabled={!canWriteOrgKey}
                  title={canWriteOrgKey ? undefined : t('apiKey.orgAdminsOnly')}
                >
                  {t('apiKey.everyoneInOrg')}
                </SegmentedControlItem>
              </SegmentedControl>
            </div>
          )}
          {personalOnlyWarning && (
            <Txt as="p" variant="caption" tone="muted" role="note">
              {t('apiKey.personalOnlyWarning', { name: displayName })}
            </Txt>
          )}
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
