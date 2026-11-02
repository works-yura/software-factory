import { Button } from '@mastra/playground-ui/components/Button';
import { Spinner } from '@mastra/playground-ui/components/Spinner';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { LogIn } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useClaudeSignIn } from '../../../../../../hooks/useCredentialAccounts';
import { accountErrorMessage, CLAUDE_ACCOUNTS_PROVIDER } from './accountErrors';

/** Where a sign-in stands, in words; nothing before it started. */
export function ClaudeSignInStatus({ signIn }: { signIn: ReturnType<typeof useClaudeSignIn> }) {
  const { t } = useTranslation('settings');
  if (signIn.error) {
    return (
      <Txt as="p" variant="caption" className="text-destructive-foreground" role="alert">
        {accountErrorMessage(signIn.error)}
      </Txt>
    );
  }
  if (signIn.status === 'pending') {
    return (
      <Txt as="p" variant="caption" tone="muted" role="status" className="flex items-center gap-2">
        <Spinner size="sm" aria-hidden /> {t('claudeAccounts.signIn.pending')}
      </Txt>
    );
  }
  if (signIn.status === 'error') {
    return (
      <Txt as="p" variant="caption" className="text-destructive-foreground" role="alert">
        {signIn.signIn?.error ?? t('claudeAccounts.signIn.failed')}
      </Txt>
    );
  }
  if (signIn.status === 'done') {
    return (
      <Txt as="p" variant="caption" tone="muted" role="status">
        {t('claudeAccounts.signIn.done', { label: signIn.signIn?.account?.label ?? 'Claude' })}
      </Txt>
    );
  }
  return null;
}

/**
 * Sign in to Claude for Factory runs: the server runs `claude auth login`,
 * the sign-in page opens in the browser on its machine, and the login is
 * kept as the person's own account. Shown only where the server offers it.
 */
export function ClaudeSignInButton({ disabled }: { disabled?: boolean }) {
  const { t } = useTranslation('settings');
  const signIn = useClaudeSignIn(CLAUDE_ACCOUNTS_PROVIDER);
  const pending = signIn.status === 'pending';
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={disabled || pending} onClick={signIn.start}>
          <LogIn size={13} /> {t('claudeAccounts.signIn.button')}
        </Button>
        {pending && signIn.signIn && (
          <Button size="sm" variant="ghost" onClick={signIn.cancel}>
            {t('claudeAccounts.cancel')}
          </Button>
        )}
      </div>
      <ClaudeSignInStatus signIn={signIn} />
    </div>
  );
}
