/**
 * Credential accounts: several credentials for one model provider in one
 * organization, so a run that hits one account's usage limit can go on with
 * another (see `@factory/credentials` `pickCredentialAccount`).
 *
 * Kinds, with different owners:
 * - sign-ins (`claude_login`, a person's Claude sign-in for Claude Code;
 *   `codex_login`, a person's ChatGPT sign-in for Codex): each records whose
 *   it is (`ownerUserId`) and only that person's runs use it. It keeps the
 *   OAuth pair, which only the server refreshes: a run gets the access token
 *   alone, so no copy of the rotating refresh token lives anywhere else to
 *   fall out of step. The turn-based harnesses run on these alone.
 * - `api_key` (an organization key) and `subscription` (a person's pasted
 *   `claude setup-token`): no longer added and never used by a run; rows left
 *   from before are kept only so they can be listed as legacy and removed.
 *
 * Secrets are encrypted at rest with the domain's encryption and never leave
 * the server; listings carry a four-character hint instead.
 */

import type { CollectionSchema } from '@mastra/core/storage';

export type CredentialAccountKind = 'api_key' | 'subscription' | 'claude_login' | 'codex_login';

/** The sign-in kinds: an OAuth pair a person signed in with, refreshed by the server alone. */
export const SIGN_IN_CREDENTIAL_KINDS = ['claude_login', 'codex_login'] as const satisfies readonly CredentialAccountKind[];

export type SignInCredentialKind = (typeof SIGN_IN_CREDENTIAL_KINDS)[number];

export function isSignInCredentialKind(kind: CredentialAccountKind): kind is SignInCredentialKind {
  return (SIGN_IN_CREDENTIAL_KINDS as readonly string[]).includes(kind);
}

/** Kinds that belong to one person and serve only that person's runs. */
export function isPersonalCredentialKind(kind: CredentialAccountKind): boolean {
  return kind !== 'api_key';
}

/** A sign-in: the OAuth pair the server refreshes, and who signed in (not secret, but kept with it). */
export interface SignInOAuth {
  accessToken: string;
  refreshToken: string;
  /** When the access token expires, in epoch milliseconds. */
  expiresAt: number;
  scopes: string[];
  /** The plan the sign-in is on (Claude's `subscriptionType`, ChatGPT's `plan_type`). */
  subscriptionType?: string;
  email?: string;
  accountUuid?: string;
  organizationUuid?: string;
  /** The OpenID token the provider answered with (ChatGPT sign-ins). */
  idToken?: string;
  /** The provider's workspace the tokens act in (ChatGPT's `chatgpt_account_id`). */
  workspaceId?: string;
}

/** A Claude sign-in (`claude auth login`). */
export type ClaudeLoginOAuth = SignInOAuth;

export interface CredentialAccount {
  id: string;
  orgId: string;
  provider: string;
  label: string;
  kind: CredentialAccountKind;
  /** Whose subscription this is; absent for an organization API key. */
  ownerUserId?: string;
  /** Lower goes first. */
  priority: number;
  /** Skipped by every run: turned off by a person, or by a failed sign-in. */
  disabled: boolean;
  /** Skipped until then: the provider said the account is out of usage. */
  limitedUntil?: Date;
  /** Why the account was last limited or turned off. */
  lastError?: string;
  lastUsedAt?: Date;
  /** The secret's last four characters, to tell accounts apart. */
  hint: string;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface AddCredentialAccountInput {
  orgId: string;
  provider: string;
  label: string;
  kind: CredentialAccountKind;
  ownerUserId?: string;
  /** For a sign-in, the access token of {@link oauth}. */
  secret: string;
  /** A sign-in's OAuth pair. */
  oauth?: SignInOAuth;
  createdBy: string;
  priority?: number;
}

export interface UpdateCredentialAccountInput {
  label?: string;
  priority?: number;
  disabled?: boolean;
  /** A new secret also clears the account's limit and error, and turns it back on. */
  secret?: string;
  /** A new sign-in for a sign-in account; like a new secret, it turns the account back on. */
  oauth?: SignInOAuth;
}

export const CREDENTIAL_ACCOUNTS = 'model_credential_accounts';

export const CREDENTIAL_ACCOUNTS_SCHEMA: CollectionSchema = {
  name: CREDENTIAL_ACCOUNTS,
  columns: {
    id: { type: 'uuid-pk' },
    org_id: { type: 'text' },
    provider: { type: 'text' },
    label: { type: 'text' },
    kind: { type: 'text' },
    owner_user_id: { type: 'text', nullable: true },
    data: { type: 'json' },
    secret_hint: { type: 'text' },
    priority: { type: 'integer', default: 0 },
    disabled: { type: 'boolean', default: false },
    limited_until: { type: 'timestamp', nullable: true },
    last_error: { type: 'text', nullable: true },
    last_used_at: { type: 'timestamp', nullable: true },
    created_by: { type: 'text' },
    created_at: { type: 'timestamp' },
    updated_at: { type: 'timestamp' },
  },
  indexes: [{ name: 'model_credential_accounts_org_provider_idx', columns: ['org_id', 'provider'] }],
};

/** Column shape of one `model_credential_accounts` row as returned by ops. */
export interface CredentialAccountDbRow extends Record<string, unknown> {
  id: string;
  org_id: string;
  provider: string;
  label: string;
  kind: CredentialAccountKind;
  owner_user_id: string | null;
  data: unknown;
  secret_hint: string;
  priority: number;
  disabled: boolean | number;
  limited_until: Date | null;
  last_error: string | null;
  last_used_at: Date | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

/** The encrypted payload of a row. */
export interface CredentialAccountSecret {
  secret: string;
  oauth?: SignInOAuth;
}

/** How long a stored error message may be. */
const MAX_ERROR_LENGTH = 500;

/** A sign-in's access token changes on every refresh, so it has no stable hint; its label names the account. */
export function accountSecretHint(kind: CredentialAccountKind, secret: string): string {
  return isSignInCredentialKind(kind) ? '' : secretHint(secret);
}

export function secretHint(secret: string): string {
  return secret.length > 8 ? secret.slice(-4) : '';
}

export function boundedError(message: string): string {
  const trimmed = message.trim();
  return trimmed.length > MAX_ERROR_LENGTH ? `${trimmed.slice(0, MAX_ERROR_LENGTH)}…` : trimmed;
}

export function toCredentialAccount(row: CredentialAccountDbRow): CredentialAccount {
  return {
    id: row.id,
    orgId: row.org_id,
    provider: row.provider,
    label: row.label,
    kind: row.kind,
    ...(row.owner_user_id ? { ownerUserId: row.owner_user_id } : {}),
    priority: Number(row.priority ?? 0),
    disabled: Boolean(row.disabled),
    ...(row.limited_until ? { limitedUntil: row.limited_until } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
    ...(row.last_used_at ? { lastUsedAt: row.last_used_at } : {}),
    hint: row.secret_hint,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
