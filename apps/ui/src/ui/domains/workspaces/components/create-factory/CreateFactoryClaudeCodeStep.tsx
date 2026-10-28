import { CommandGroup } from '@mastra/playground-ui/components/Command';
import { CommandPaletteItem } from '@mastra/playground-ui/components/CommandPalette';
import { Kbd } from '@mastra/playground-ui/components/Kbd';
import { Spinner } from '@mastra/playground-ui/components/Spinner';
import { Plus, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ApiRequestError } from '../../../../../api/client';
import { useCredentialAccountsQuery } from '../../../../../hooks/useCredentialAccounts';
import { useServerFeatures } from '../../../../../hooks/useServerFeatures';
import { SkeletonRows } from '../../../../ui/SkeletonRows';
import { CLAUDE_ACCOUNTS_PROVIDER } from '../../../settings/components/models/accounts/accountErrors';
import { ClaudeAccountDialog } from '../../../settings/components/models/accounts/ClaudeAccountDialog';
import type { ClaudeAccountDialogMode } from '../../../settings/components/models/accounts/ClaudeAccountDialog';
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

/** How Claude Code turns sign in: the local `claude` login, or the organization's Claude Code accounts. */
function ClaudeCodeSignIn({ disabled }: { disabled: boolean }) {
  const { t } = useTranslation('workspaces');
  const features = useServerFeatures();
  const accountsQuery = useCredentialAccountsQuery(CLAUDE_ACCOUNTS_PROVIDER);
  const [dialog, setDialog] = useState<ClaudeAccountDialogMode | null>(null);
  const localLogin = features.data?.claudeCodeLocalLogin === true;
  const accounts = accountsQuery.data?.accounts ?? [];
  const needsSignIn =
    accountsQuery.error instanceof ApiRequestError && accountsQuery.error.code === 'accounts_need_sign_in';

  let status;
  if (features.isPending || (!localLogin && accountsQuery.isPending)) {
    status = (
      <SkeletonRows
        label={t('createFactory.claudeCode.signIn.loading')}
        rows={1}
        rowClassName="mx-2 my-1 h-8 rounded-xl"
      />
    );
  } else if (localLogin) {
    status = (
      <CreateFactoryPaletteMessage>
        {t('createFactory.claudeCode.signIn.localLogin')} {t('createFactory.claudeCode.signIn.addHint')}
      </CreateFactoryPaletteMessage>
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
        {accountsQuery.data && (
          <CommandPaletteItem
            icon={<Plus />}
            title={t('createFactory.claudeCode.signIn.add')}
            subtitle={t('createFactory.claudeCode.signIn.addDescription')}
            value="claude-signin-add"
            disabled={disabled}
            onSelect={() => setDialog({ kind: 'add', canAddOrgKeys: accountsQuery.data.canAddOrgKeys })}
          />
        )}
      </CommandGroup>
      {dialog && <ClaudeAccountDialog mode={dialog} onClose={() => setDialog(null)} />}
    </>
  );
}
