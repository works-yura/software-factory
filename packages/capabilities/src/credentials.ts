/**
 * Accounts an organization already keeps in one integration that another part of the Factory may
 * use by reference — e.g. an MCP server filled from a Google Cloud account the person connected for
 * logs, instead of pasting the same key again. The provider lists them (never their secrets),
 * hands the secret only to the code that launches something with it, and can suggest values a
 * Factory's binding already knows (its Google Cloud project).
 */

/** Kinds of account a provider can lend. */
export type CredentialKind = 'google-cloud-account';

/** Values a provider can suggest for a Factory. */
export type CredentialSuggestion = 'google-cloud-project';

export interface CredentialOption {
  id: string;
  name: string;
  /** What tells two accounts apart for a person (an email, a project). */
  detail?: string;
}

export interface CredentialProvider {
  readonly kind: CredentialKind;
  list(orgId: string): Promise<CredentialOption[]>;
  /** The secret itself (a key file's content), for the launcher only; `null` when the account is gone. */
  readSecret(orgId: string, id: string): Promise<string | null>;
  /** Values the Factory's own binding knows, e.g. its Google Cloud project. */
  suggest?(orgId: string, factoryProjectId: string): Promise<Partial<Record<CredentialSuggestion, string>>>;
}
