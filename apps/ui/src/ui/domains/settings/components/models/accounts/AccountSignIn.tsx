import { Button } from '@mastra/playground-ui/components/Button';
import { Spinner } from '@mastra/playground-ui/components/Spinner';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { LogIn } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useAccountSignIn } from '../../../../../../hooks/useCredentialAccounts';
import { accountErrorMessage } from './accountErrors';
import type { HarnessAccounts } from './harnessAccounts';

/** Where a sign-in stands, in words; nothing before it started. */
export function AccountSignInStatus({
  accounts,
  signIn,
}: {
  accounts: HarnessAccounts;
  signIn: ReturnType<typeof useAccountSignIn>;
}) {
  const { t } = useTranslation('settings');
  const texts = `accounts.harness.${accounts.i18nKey}` as const;
  if (signIn.error) {
    return (
      <Txt as="p" variant="caption" className="text-destructive-foreground" role="alert">
        {accountErrorMessage(signIn.error, accounts)}
      </Txt>
    );
  }
  if (signIn.status === 'pending') {
    return (
      <Txt as="p" variant="caption" tone="muted" role="status" className="flex items-center gap-2">
        <Spinner size="sm" aria-hidden /> {t(`${texts}.signIn.pending`)}
      </Txt>
    );
  }
  if (signIn.status === 'error') {
    return (
      <Txt as="p" variant="caption" className="text-destructive-foreground" role="alert">
        {signIn.signIn?.error ?? t(`${texts}.signIn.failed`)}
      </Txt>
    );
  }
  if (signIn.status === 'done') {
    return (
      <Txt as="p" variant="caption" tone="muted" role="status">
        {t('accounts.signIn.done', { label: signIn.signIn?.account?.label ?? '' })}
      </Txt>
    );
  }
  return null;
}

/**
 * Sign in for a harness's runs: the server runs the provider's CLI sign-in
 * (`claude auth login`, `codex login`), whose page opens in the browser on its
 * machine, and the login is kept as the person's own account. Shown only where
 * the server offers it (local development).
 */
export function AccountSignInButton({ accounts, disabled }: { accounts: HarnessAccounts; disabled?: boolean }) {
  const { t } = useTranslation('settings');
  const signIn = useAccountSignIn(accounts.provider);
  const pending = signIn.status === 'pending';
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={disabled || pending} onClick={signIn.start}>
          <LogIn size={13} /> {t(`accounts.harness.${accounts.i18nKey}.signIn.button`)}
        </Button>
        {pending && signIn.signIn && (
          <Button size="sm" variant="ghost" onClick={signIn.cancel}>
            {t('accounts.cancel')}
          </Button>
        )}
      </div>
      <AccountSignInStatus accounts={accounts} signIn={signIn} />
    </div>
  );
}
