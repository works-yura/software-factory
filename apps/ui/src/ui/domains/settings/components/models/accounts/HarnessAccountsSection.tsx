import { AlertDialog } from '@mastra/playground-ui/components/AlertDialog';
import { Badge } from '@mastra/playground-ui/components/Badge';
import { Button } from '@mastra/playground-ui/components/Button';
import { DropdownMenu } from '@mastra/playground-ui/components/DropdownMenu';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { Status } from '@mastra/playground-ui/components/StatusIndicators';
import type { StatusPresentation } from '@mastra/playground-ui/components/StatusIndicators';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { SettingsContainer } from '@mastra/playground-ui/new/settings';
import { MoreHorizontal } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ApiRequestError } from '../../../../../../api/client';
import type { CredentialAccountInfo } from '../../../../../../api/types';
import {
  useCredentialAccountsQuery,
  useRemoveCredentialAccount,
  useUpdateCredentialAccount,
} from '../../../../../../hooks/useCredentialAccounts';
import { useServerFeatures } from '../../../../../../hooks/useServerFeatures';
import { currentLanguage } from '../../../../../i18n';
import { translator } from '../../../../../i18n/t';
import { SkeletonRows } from '../../../../../ui/SkeletonRows';
import { SettingsSubsection } from '../../SettingsSubsection';
import { accountErrorMessage } from './accountErrors';
import { AccountRenameDialog } from './AccountRenameDialog';
import { AccountSignInButton } from './AccountSignIn';
import type { HarnessAccounts } from './harnessAccounts';

const tk = translator('settings');

export function formatAccountTime(iso: string): string {
  return new Intl.DateTimeFormat(currentLanguage(), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
}

/**
 * The sign-ins a turn-based harness's sessions run on (Claude Code's Claude
 * sign-ins, Codex's ChatGPT sign-ins; see `harnessAccounts`): when one runs
 * out of usage the session continues on the next, a limited one returns after
 * its reset, a refused one stays off until its owner signs in again. A sign-in
 * serves only its owner's runs. Signing in is the only way to add one; a
 * pasted token or key left from before is marked old and can only be removed.
 */
export function HarnessAccountsSection({ accounts: harness }: { accounts: HarnessAccounts }) {
  const { t } = useTranslation('settings');
  const accountsQuery = useCredentialAccountsQuery(harness.provider);
  const features = useServerFeatures();
  const updateMutation = useUpdateCredentialAccount(harness.provider);
  const removeMutation = useRemoveCredentialAccount(harness.provider);
  const texts = `accounts.harness.${harness.i18nKey}` as const;
  const [renaming, setRenaming] = useState<CredentialAccountInfo | null>(null);
  const [removing, setRemoving] = useState<CredentialAccountInfo | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const data = accountsQuery.data;
  const busy = updateMutation.isPending || removeMutation.isPending;
  const needsSignIn =
    accountsQuery.error instanceof ApiRequestError && accountsQuery.error.code === 'accounts_need_sign_in';

  const run = (action: Promise<unknown>) => {
    setActionError(null);
    action.catch(error => setActionError(accountErrorMessage(error, harness)));
  };

  return (
    <SettingsSubsection scope="org" title={t(`${texts}.title`)} description={t(`${texts}.description`)}>
      <SettingsContainer className="flex flex-col gap-3 p-4">
        {features.data?.[harness.signInFeature] === true && data && <AccountSignInButton accounts={harness} disabled={busy} />}
        {accountsQuery.isPending && <SkeletonRows label={t(`${texts}.loading`)} rows={2} />}
        {needsSignIn && <Notice variant="info">{t(`${texts}.errors.needSignIn`)}</Notice>}
        {accountsQuery.isError && !needsSignIn && (
          <Notice variant="destructive">{accountErrorMessage(accountsQuery.error, harness)}</Notice>
        )}
        {data && data.accounts.every(account => account.legacy === true) && (
          <Txt as="p" variant="caption" tone="muted">
            {t(`${texts}.empty`)}
          </Txt>
        )}
        {data && data.accounts.length > 0 && (
          <ul aria-label={t(`${texts}.title`)} className="divide-border flex flex-col divide-y">
            {data.accounts.map(account => (
              <AccountRow
                key={account.id}
                accounts={harness}
                account={account}
                disabled={busy}
                onToggle={() =>
                  run(updateMutation.mutateAsync({ id: account.id, disabled: account.status !== 'disabled' }))
                }
                onRename={() => setRenaming(account)}
                onRemove={() => setRemoving(account)}
              />
            ))}
          </ul>
        )}
        {actionError && (
          <Txt as="p" variant="caption" className="text-destructive-foreground" role="alert">
            {actionError}
          </Txt>
        )}
      </SettingsContainer>

      {renaming && <AccountRenameDialog accounts={harness} account={renaming} onClose={() => setRenaming(null)} />}

      <AlertDialog open={removing !== null} onOpenChange={open => !open && setRemoving(null)}>
        <AlertDialog.Content>
          <AlertDialog.Header>
            <AlertDialog.Title>{t('accounts.removeTitle', { label: removing?.label ?? '' })}</AlertDialog.Title>
            <AlertDialog.Description>{t('accounts.removeDescription')}</AlertDialog.Description>
          </AlertDialog.Header>
          <AlertDialog.Footer>
            <AlertDialog.Cancel>{t('accounts.cancel')}</AlertDialog.Cancel>
            <AlertDialog.Action onClick={() => removing && run(removeMutation.mutateAsync(removing.id))}>
              {t('accounts.remove')}
            </AlertDialog.Action>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog>
    </SettingsSubsection>
  );
}

function statusPresentation(account: CredentialAccountInfo): StatusPresentation {
  if (account.needsSignIn) {
    return { label: tk('accounts.status.needsSignIn'), tone: 'neutral', description: '' } satisfies StatusPresentation;
  }
  if (account.status === 'disabled') {
    return { label: tk('accounts.status.off'), tone: 'neutral', description: '' } satisfies StatusPresentation;
  }
  if (account.status === 'limited') {
    const label = account.limitedUntil
      ? tk('accounts.status.limitedUntil', { time: formatAccountTime(account.limitedUntil) })
      : tk('accounts.status.limited');
    return { label, tone: 'progress', description: '' } satisfies StatusPresentation;
  }
  return { label: tk('accounts.status.active'), tone: 'success', description: '' } satisfies StatusPresentation;
}

function AccountRow({
  accounts: harness,
  account,
  disabled,
  onToggle,
  onRename,
  onRemove,
}: {
  accounts: HarnessAccounts;
  account: CredentialAccountInfo;
  disabled: boolean;
  onToggle: () => void;
  onRename: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation('settings');
  // A pasted token or key from before sign-ins: no session uses it, so it is only there to be removed.
  const legacy = account.legacy === true;
  const kindLabel = legacy
    ? t('accounts.kind.legacy')
    : account.mine
      ? t(`accounts.harness.${harness.i18nKey}.kind.mySignIn`)
      : t(`accounts.harness.${harness.i18nKey}.kind.memberSignIn`);

  return (
    <li aria-label={account.label} className="flex items-start gap-2.5 py-2">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <Txt as="span" variant="caption" className="truncate">
            {account.label}
          </Txt>
          <Badge size="xs" variant={legacy ? 'orange' : 'neutral'}>
            {kindLabel}
          </Badge>
          {account.hint && (
            <Txt as="span" variant="meta" tone="muted" font="mono" className="shrink-0">
              …{account.hint}
            </Txt>
          )}
        </div>
        {account.lastError && (
          <Txt as="p" variant="meta" className="text-destructive-foreground break-words">
            {account.lastError}
          </Txt>
        )}
        <Txt as="p" variant="meta" tone="muted">
          {account.lastUsedAt
            ? t('accounts.lastUsed', { time: formatAccountTime(account.lastUsedAt) })
            : t('accounts.neverUsed')}
        </Txt>
      </div>
      {!legacy && (
        <Txt as="span" variant="meta" tone="muted" className="shrink-0 pt-0.5">
          <Status presentation={statusPresentation(account)} />
        </Txt>
      )}
      {account.canManage ? (
        <DropdownMenu>
          <DropdownMenu.Trigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('accounts.actionsFor', { label: account.label })}
                disabled={disabled}
              >
                <MoreHorizontal />
              </Button>
            }
          />
          <DropdownMenu.Content align="end">
            {!legacy && (
              <DropdownMenu.Item onClick={onToggle}>
                {account.status === 'disabled' ? t('accounts.turnOn') : t('accounts.turnOff')}
              </DropdownMenu.Item>
            )}
            {!legacy && <DropdownMenu.Item onClick={onRename}>{t('accounts.rename')}</DropdownMenu.Item>}
            <DropdownMenu.Item variant="destructive" onClick={onRemove}>
              {t('accounts.remove')}
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu>
      ) : (
        <span aria-hidden="true" className="size-control-sm shrink-0" />
      )}
    </li>
  );
}
