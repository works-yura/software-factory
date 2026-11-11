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

/** What a provider can look up with one of its accounts, to offer as choices in a form. */
export type DiscoverySource = 'google-cloud-projects' | 'firestore-databases';
export const DISCOVERY_SOURCES: readonly DiscoverySource[] = ['google-cloud-projects', 'firestore-databases'];

export interface DiscoveryItem {
  value: string;
  /** What a person reads (a project's display name), when it differs from the value. */
  label?: string;
  detail?: string;
}

/**
 * Choices found with an account. A refusal never fails the form: `items` still carries what is known
 * without the call (the key's own project, the `(default)` database) and `denied` says what to grant.
 */
export interface DiscoveryResult {
  items: DiscoveryItem[];
  /** The obvious pick (the key's own project, `(default)`). */
  default?: string;
  denied?: { role?: string; message: string };
}

export interface CredentialProvider {
  readonly kind: CredentialKind;
  list(orgId: string): Promise<CredentialOption[]>;
  /** The secret itself (a key file's content), for the launcher only; `null` when the account is gone. */
  readSecret(orgId: string, id: string): Promise<string | null>;
  /** Values the Factory's own binding knows, e.g. its Google Cloud project. */
  suggest?(orgId: string, factoryProjectId: string): Promise<Partial<Record<CredentialSuggestion, string>>>;
  /**
   * Looks up choices with one account, read-only; `context` carries the other inputs a source
   * depends on (`project` for databases). Never returns a secret.
   */
  discover?(orgId: string, accountId: string, source: DiscoverySource, context: Record<string, string>): Promise<DiscoveryResult>;
}
