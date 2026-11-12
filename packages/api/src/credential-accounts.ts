/**
 * The turn-based harnesses' accounts: which provider each harness's sign-ins are filed under and the
 * sign-in a person runs for them. Settings › Підключення shows and changes them through each
 * harness's agent connector (`agent-connections.ts`, ADR-0036); the old
 * `/web/config/providers/:provider/accounts*` routes are gone.
 */
import type { SignInCredentialKind } from '@factory/store';

/** The provider Claude Code turns read their sign-ins from. */
export const CLAUDE_CODE_ACCOUNT_PROVIDER = 'anthropic';
/** The provider Codex turns read their ChatGPT sign-ins from. */
export const CODEX_ACCOUNT_PROVIDER = 'openai-codex';

/** Each turn-based harness's accounts: the provider they are filed under, the sign-in kind its turns run on, and its name. */
export const SIGN_IN_ACCOUNT_PROVIDERS: Readonly<Record<string, { kind: SignInCredentialKind; name: string; harness: string }>> = {
  [CLAUDE_CODE_ACCOUNT_PROVIDER]: { kind: 'claude_login', name: 'Claude', harness: 'Claude Code' },
  [CODEX_ACCOUNT_PROVIDER]: { kind: 'codex_login', name: 'ChatGPT', harness: 'Codex' },
};

/** Providers whose runs rotate through several accounts: one per turn-based harness. */
export const CREDENTIAL_ACCOUNT_PROVIDERS: ReadonlySet<string> = new Set(Object.keys(SIGN_IN_ACCOUNT_PROVIDERS));

/** One sign-in a person started (see the server's `createAccountSignInService`). */
export interface AccountSignInFlowView {
  id: string;
  orgId: string;
  userId: string;
  status: 'pending' | 'done' | 'error';
  error?: string;
  accountId?: string;
}

/** Runs a provider's sign-in for a person (`claude auth login`, `codex login`), on the server's machine. */
export interface AccountSignInFlows {
  start(owner: { orgId: string; userId: string }): AccountSignInFlowView;
  get(id: string): AccountSignInFlowView | undefined;
  cancel(id: string): boolean;
}

/** @deprecated Claude's alone; see {@link AccountSignInFlowView}. */
export type ClaudeSignInFlowView = AccountSignInFlowView;
/** @deprecated Claude's alone; see {@link AccountSignInFlows}. */
export type ClaudeSignInFlows = AccountSignInFlows;
