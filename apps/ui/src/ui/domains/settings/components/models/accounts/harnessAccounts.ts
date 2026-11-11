import type { HarnessDescriptor } from '@factory/contracts/harnesses';

import type { ServerFeatures } from '../../../../../../hooks/useServerFeatures';

/**
 * What the accounts section needs of a turn-based harness: where its sign-ins
 * are filed, whether this server offers signing in, and which texts and brand
 * it shows. Claude Code and Codex differ only here; the section is one.
 */
export interface HarnessAccounts {
  harnessId: string;
  /** The credential-account provider its turns read (`/web/config/providers/:provider/accounts`). */
  provider: string;
  /** The server feature that says signing in is offered here. */
  signInFeature: keyof Pick<ServerFeatures, 'claudeSignIn' | 'codexSignIn'>;
  /** The texts under `settings:accounts.harness.<key>`. */
  i18nKey: 'claudeCode' | 'codex';
  /** The `ProviderBrandIcon` the sign-in shows. */
  brand: string;
}

export const CLAUDE_CODE_ACCOUNTS: HarnessAccounts = {
  harnessId: 'claude-code',
  provider: 'anthropic',
  signInFeature: 'claudeSignIn',
  i18nKey: 'claudeCode',
  brand: 'anthropic',
};

export const CODEX_ACCOUNTS: HarnessAccounts = {
  harnessId: 'codex',
  provider: 'openai-codex',
  signInFeature: 'codexSignIn',
  i18nKey: 'codex',
  brand: 'openai',
};

const BY_PROVIDER: Record<string, HarnessAccounts> = {
  [CLAUDE_CODE_ACCOUNTS.provider]: CLAUDE_CODE_ACCOUNTS,
  [CODEX_ACCOUNTS.provider]: CODEX_ACCOUNTS,
};

/** The accounts a harness's turns run on, from its descriptor; `undefined` for a harness without (Mastra). */
export function harnessAccounts(descriptor: Pick<HarnessDescriptor, 'setup'> | undefined): HarnessAccounts | undefined {
  const provider = descriptor?.setup.accounts?.provider;
  return provider ? BY_PROVIDER[provider] : undefined;
}
