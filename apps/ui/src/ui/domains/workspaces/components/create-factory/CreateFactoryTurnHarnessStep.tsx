import { CommandGroup } from '@mastra/playground-ui/components/Command';
import { CommandPaletteItem } from '@mastra/playground-ui/components/CommandPalette';
import { Kbd } from '@mastra/playground-ui/components/Kbd';
import { Spinner } from '@mastra/playground-ui/components/Spinner';
import { LogIn, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { CLAUDE_CODE_MODELS } from '@factory/harness-claude-code/models/aliases';

import { ApiRequestError } from '../../../../../api/client';
import { useModelCatalogQuery } from '../../../../../hooks/useAvailableModels';
import { useAccountSignIn, useCredentialAccountsQuery } from '../../../../../hooks/useCredentialAccounts';
import { useServerFeatures } from '../../../../../hooks/useServerFeatures';
import { SkeletonRows } from '../../../../ui/SkeletonRows';
import { AccountSignInStatus } from '../../../settings/components/models/accounts/AccountSignIn';
import { CLAUDE_CODE_ACCOUNTS, CODEX_ACCOUNTS } from '../../../settings/components/models/accounts/harnessAccounts';
import type { HarnessAccounts } from '../../../settings/components/models/accounts/harnessAccounts';
import { TURN_HARNESS_TEXT_KEY } from '../../services/turnHarness';
import type { TurnHarness } from '../../services/turnHarness';
import { ProviderBrandIcon } from '../ProviderBrandIcon';
import { CreateFactoryPaletteAlert, CreateFactoryPaletteMessage } from './CreateFactoryPalette';

export interface CreateFactoryTurnHarnessStepProps {
  harness: TurnHarness;
  query: string;
  /** The model being written to the Factory being created; null is the harness's own default. */
  saving?: { model: string | null };
  error?: string;
  onPick: (model: string | null) => void;
}

/** One model row: its id (null = the harness's default) and how it reads. */
interface ModelOption {
  model: string | null;
  title: string;
  description?: string;
}

/** The texts under `workspaces:createFactory.<key>` and the accounts each harness's turns run on. */
const TURN_HARNESS_STEP: Record<TurnHarness, { key: (typeof TURN_HARNESS_TEXT_KEY)[TurnHarness]; accounts: HarnessAccounts }> = {
  'claude-code': { key: TURN_HARNESS_TEXT_KEY['claude-code'], accounts: CLAUDE_CODE_ACCOUNTS },
  codex: { key: TURN_HARNESS_TEXT_KEY.codex, accounts: CODEX_ACCOUNTS },
};

/** The models a new Factory of the harness may start on: Claude Code's CLI aliases, or Codex's catalog. */
function useModelOptions(harness: TurnHarness): { options: ModelOption[]; loading: boolean } {
  const { t } = useTranslation('workspaces');
  const catalog = useModelCatalogQuery();
  if (harness === 'claude-code') {
    return {
      loading: false,
      options: [null, ...CLAUDE_CODE_MODELS].map(model => ({
        model,
        title: t(`createFactory.claudeCode.models.${model ?? 'default'}.title`),
        description: t(`createFactory.claudeCode.models.${model ?? 'default'}.description`),
      })),
    };
  }
  const instance = catalog.data?.instances?.find(entry => entry.instanceId === harness);
  return {
    loading: catalog.isPending,
    options: [
      { model: null, title: t('createFactory.codex.models.default.title'), description: t('createFactory.codex.models.default.description') },
      ...(instance?.models ?? [])
        .filter(model => !model.isLegacy)
        .map(model => ({ model: model.slug, title: model.name, description: model.slug })),
    ],
  };
}

/**
 * The last step for a Factory on a turn-based harness (Claude Code, Codex): there is no provider to
 * connect (its runs sign in with the members' accounts), so it shows what turns will sign in with
 * and asks only which model to run, saved as the Factory's default for that harness.
 */
export function CreateFactoryTurnHarnessStep({ harness, query, saving, error, onPick }: CreateFactoryTurnHarnessStepProps) {
  const { t } = useTranslation('workspaces');
  const { key } = TURN_HARNESS_STEP[harness];
  const normalizedQuery = query.trim().toLowerCase();
  const { options, loading } = useModelOptions(harness);
  const models = options.filter(
    option => option.title.toLowerCase().includes(normalizedQuery) || (option.model ?? 'default').toLowerCase().includes(normalizedQuery),
  );
  const busy = saving !== undefined;

  return (
    <>
      {error && <CreateFactoryPaletteAlert>{error}</CreateFactoryPaletteAlert>}
      <TurnHarnessSignIn harness={harness} disabled={busy} />
      {loading ? (
        <SkeletonRows label={t(`createFactory.${key}.models.heading`)} rows={2} rowClassName="mx-2 my-1 h-8 rounded-xl" />
      ) : models.length > 0 ? (
        <CommandGroup heading={t(`createFactory.${key}.models.heading`)}>
          {models.map(option => {
            const id = option.model ?? 'default';
            return (
              <CommandPaletteItem
                key={id}
                icon={
                  busy && saving.model === option.model ? (
                    <Spinner size="sm" aria-label={t('createFactory.models.creating')} />
                  ) : option.model ? (
                    <ProviderBrandIcon provider={TURN_HARNESS_STEP[harness].accounts.brand} />
                  ) : (
                    <Sparkles />
                  )
                }
                title={option.title}
                subtitle={option.description}
                shortcut={<Kbd size="sm">↵</Kbd>}
                value={`${harness}-model-${id}`}
                disabled={busy}
                onSelect={() => onPick(option.model)}
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

/** How the harness's turns sign in: the members' sign-ins, never the machine's own CLI login. */
function TurnHarnessSignIn({ harness, disabled }: { harness: TurnHarness; disabled: boolean }) {
  const { t } = useTranslation('workspaces');
  const { key, accounts: harnessAccounts } = TURN_HARNESS_STEP[harness];
  const features = useServerFeatures();
  const accountsQuery = useCredentialAccountsQuery(harnessAccounts.provider);
  const signIn = useAccountSignIn(harnessAccounts.provider);
  // A pasted token or key from before sign-ins runs nothing, so it does not count.
  const accounts = (accountsQuery.data?.accounts ?? []).filter(account => account.legacy !== true);
  // With no account yet, signing in is the quickest way to give the Factory its own.
  const offerSignIn = features.data?.[harnessAccounts.signInFeature] === true && accountsQuery.data !== undefined && accounts.length === 0;
  const needsSignIn = accountsQuery.error instanceof ApiRequestError && accountsQuery.error.code === 'accounts_need_sign_in';

  let status;
  if (features.isPending || accountsQuery.isPending) {
    status = <SkeletonRows label={t(`createFactory.${key}.signIn.loading`)} rows={1} rowClassName="mx-2 my-1 h-8 rounded-xl" />;
  } else if (accounts.length > 0) {
    status = (
      <CreateFactoryPaletteMessage>
        {t(`createFactory.${key}.signIn.accounts`, { count: accounts.length })} {t(`createFactory.${key}.signIn.addHint`)}
      </CreateFactoryPaletteMessage>
    );
  } else {
    status = (
      <CreateFactoryPaletteMessage>
        {needsSignIn
          ? t(`createFactory.${key}.signIn.needSignIn`)
          : `${t(`createFactory.${key}.signIn.none`)} ${t(`createFactory.${key}.signIn.addHint`)}`}
      </CreateFactoryPaletteMessage>
    );
  }

  return (
    <CommandGroup heading={t(`createFactory.${key}.signIn.heading`)}>
      {status}
      {offerSignIn && (
        <CommandPaletteItem
          icon={signIn.status === 'pending' ? <Spinner size="sm" aria-hidden /> : <LogIn />}
          title={t(`createFactory.${key}.signIn.signInWith`)}
          subtitle={t(`createFactory.${key}.signIn.signInWithDescription`)}
          value={`${harness}-signin`}
          disabled={disabled || signIn.status === 'pending'}
          onSelect={signIn.start}
        />
      )}
      {offerSignIn && (
        <div className="px-2">
          <AccountSignInStatus accounts={harnessAccounts} signIn={signIn} />
        </div>
      )}
    </CommandGroup>
  );
}
