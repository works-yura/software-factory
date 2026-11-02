import { CommandGroup } from '@mastra/playground-ui/components/Command';
import { CommandPaletteItem } from '@mastra/playground-ui/components/CommandPalette';
import { Kbd } from '@mastra/playground-ui/components/Kbd';
import { Spinner } from '@mastra/playground-ui/components/Spinner';
import { LogIn, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { ApiRequestError } from '../../../../../api/client';
import { useClaudeSignIn, useCredentialAccountsQuery } from '../../../../../hooks/useCredentialAccounts';
import { useServerFeatures } from '../../../../../hooks/useServerFeatures';
import { SkeletonRows } from '../../../../ui/SkeletonRows';
import { CLAUDE_ACCOUNTS_PROVIDER } from '../../../settings/components/models/accounts/accountErrors';
import { ClaudeSignInStatus } from '../../../settings/components/models/accounts/ClaudeSignIn';
import { CLAUDE_CODE_MODELS } from '../../services/github';
import type { ClaudeCodeModel } from '../../services/github';
import { ProviderBrandIcon } from '../ProviderBrandIcon';
import { CreateFactoryPaletteAlert, CreateFactoryPaletteMessage } from './CreateFactoryPalette';

export interface CreateFactoryClaudeCodeStepProps {
  query: string;
  /** The model being written to the Factory being created; null is the CLI default. */
  saving?: { model: ClaudeCodeModel | null };
  error?: string;
  onPick: (model: ClaudeCodeModel | null) => void;
}

const MODEL_OPTIONS: Array<ClaudeCodeModel | null> = [null, ...CLAUDE_CODE_MODELS];

/**
 * The last step for a Claude Code Factory: there is no provider to connect
 * (Claude Code signs in on its own), so it shows what turns will sign in with
 * and asks only which Claude model to run.
 */
export function CreateFactoryClaudeCodeStep({ query, saving, error, onPick }: CreateFactoryClaudeCodeStepProps) {
  const { t } = useTranslation('workspaces');
  const normalizedQuery = query.trim().toLowerCase();
  const models = MODEL_OPTIONS.filter(model => {
    const title = t(`createFactory.claudeCode.models.${model ?? 'default'}.title`).toLowerCase();
    return title.includes(normalizedQuery) || (model ?? 'default').includes(normalizedQuery);
  });
  const busy = saving !== undefined;

  return (
    <>
      {error && <CreateFactoryPaletteAlert>{error}</CreateFactoryPaletteAlert>}
      <ClaudeCodeSignIn disabled={busy} />
      {models.length > 0 ? (
        <CommandGroup heading={t('createFactory.claudeCode.models.heading')}>
          {models.map(model => {
            const key = model ?? 'default';
            return (
              <CommandPaletteItem
                key={key}
                icon={
                  busy && saving.model === model ? (
                    <Spinner size="sm" aria-label={t('createFactory.models.creating')} />
                  ) : model ? (
                    <ProviderBrandIcon provider="anthropic" />
                  ) : (
                    <Sparkles />
                  )
                }
                title={t(`createFactory.claudeCode.models.${key}.title`)}
                subtitle={t(`createFactory.claudeCode.models.${key}.description`)}
                shortcut={<Kbd size="sm">↵</Kbd>}
                value={`claude-model-${key}`}
                disabled={busy}
                onSelect={() => onPick(model)}
              />
            );
          })}
        </CommandGroup>
      ) : (
        <CreateFactoryPaletteMessage>{t('createFactory.models.noMatch')}</CreateFactoryPaletteMessage>
      )}
    </>
  );
}

/** How Claude Code turns sign in: the members' Claude sign-ins, never the machine's own `claude` login. */
function ClaudeCodeSignIn({ disabled }: { disabled: boolean }) {
  const { t } = useTranslation('workspaces');
  const features = useServerFeatures();
  const accountsQuery = useCredentialAccountsQuery(CLAUDE_ACCOUNTS_PROVIDER);
  const signIn = useClaudeSignIn(CLAUDE_ACCOUNTS_PROVIDER);
  // A pasted token or key from before sign-ins runs nothing, so it does not count.
  const accounts = (accountsQuery.data?.accounts ?? []).filter(account => account.legacy !== true);
  // With no account yet, signing in to Claude is the quickest way to give the Factory its own.
  const offerSignIn = features.data?.claudeSignIn === true && accountsQuery.data !== undefined && accounts.length === 0;
  const needsSignIn =
    accountsQuery.error instanceof ApiRequestError && accountsQuery.error.code === 'accounts_need_sign_in';

  let status;
  if (features.isPending || accountsQuery.isPending) {
    status = (
      <SkeletonRows
        label={t('createFactory.claudeCode.signIn.loading')}
        rows={1}
        rowClassName="mx-2 my-1 h-8 rounded-xl"
      />
    );
  } else if (accounts.length > 0) {
    status = (
      <CreateFactoryPaletteMessage>
        {t('createFactory.claudeCode.signIn.accounts', { count: accounts.length })}{' '}
        {t('createFactory.claudeCode.signIn.addHint')}
      </CreateFactoryPaletteMessage>
    );
  } else {
    status = (
      <CreateFactoryPaletteMessage>
        {needsSignIn
          ? t('createFactory.claudeCode.signIn.needSignIn')
          : `${t('createFactory.claudeCode.signIn.none')} ${t('createFactory.claudeCode.signIn.addHint')}`}
      </CreateFactoryPaletteMessage>
    );
  }

  return (
    <>
      <CommandGroup heading={t('createFactory.claudeCode.signIn.heading')}>
        {status}
        {offerSignIn && (
          <CommandPaletteItem
            icon={signIn.status === 'pending' ? <Spinner size="sm" aria-hidden /> : <LogIn />}
            title={t('createFactory.claudeCode.signIn.signInWithClaude')}
            subtitle={t('createFactory.claudeCode.signIn.signInWithClaudeDescription')}
            value="claude-signin-claude"
            disabled={disabled || signIn.status === 'pending'}
            onSelect={signIn.start}
          />
        )}
        {offerSignIn && (
          <div className="px-2">
            <ClaudeSignInStatus signIn={signIn} />
          </div>
        )}
      </CommandGroup>
    </>
  );
}
