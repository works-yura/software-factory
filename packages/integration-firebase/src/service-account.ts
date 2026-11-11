/**
 * A Google service account's key, and OAuth access tokens minted from it with Google's own
 * `google-auth-library` (JWT bearer grant, token caching). The key never leaves this module except
 * into the encrypted connection row; what anything else sees is `serviceAccountSummary`.
 */

import { createPrivateKey } from 'node:crypto';

import { JWT } from 'google-auth-library';
import { z } from 'zod';

/** The only token endpoint a key may name: a key pointing elsewhere would send its signed grant there. */
export const GOOGLE_TOKEN_URI = 'https://oauth2.googleapis.com/token';

/**
 * Least scopes per API. Cloud Logging has a read-only scope. The Crashlytics API accepts only
 * `firebase` or `cloud-platform`, so it gets the narrower `firebase`; what the key may actually do is
 * bounded by its IAM roles (Firebase Crashlytics Viewer is read-only).
 */
export const GOOGLE_SCOPES = {
  logging: 'https://www.googleapis.com/auth/logging.read',
  crashlytics: 'https://www.googleapis.com/auth/firebase',
  /** Firestore (the «База» check). Writes stay impossible while the account has only Cloud Datastore Viewer. */
  datastore: 'https://www.googleapis.com/auth/datastore',
} as const;
export type GoogleScope = (typeof GOOGLE_SCOPES)[keyof typeof GOOGLE_SCOPES];

export const serviceAccountKeySchema = z.object({
  type: z.literal('service_account'),
  project_id: z.string().min(1),
  private_key_id: z.string().min(1),
  private_key: z.string().includes('PRIVATE KEY'),
  client_email: z.string().email(),
  token_uri: z.string().optional(),
  universe_domain: z.string().optional(),
});
export type ServiceAccountKey = z.infer<typeof serviceAccountKeySchema>;

/** What may be shown about a key: never the key itself. */
export interface ServiceAccountSummary {
  clientEmail: string;
  /** The Google Cloud project the key was created in. */
  projectId: string;
  keyId: string;
}

export class ServiceAccountKeyError extends Error {
  override name = 'ServiceAccountKeyError';
}

/** Parses pasted key JSON; the message never repeats the key's content. */
export function parseServiceAccountKey(json: string): ServiceAccountKey {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new ServiceAccountKeyError('This is not JSON. Paste the whole key file Google Cloud downloaded.');
  }
  const parsed = serviceAccountKeySchema.safeParse(raw);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map(issue => issue.path.join('.') || 'type'))].join(', ');
    throw new ServiceAccountKeyError(`This is not a service account key (check: ${fields}).`);
  }
  if (parsed.data.token_uri !== undefined && parsed.data.token_uri !== GOOGLE_TOKEN_URI) {
    throw new ServiceAccountKeyError(`The key's token_uri must be ${GOOGLE_TOKEN_URI}.`);
  }
  if (parsed.data.universe_domain !== undefined && parsed.data.universe_domain !== 'googleapis.com') {
    throw new ServiceAccountKeyError('The key must be for googleapis.com (universe_domain).');
  }
  try {
    createPrivateKey(parsed.data.private_key);
  } catch {
    throw new ServiceAccountKeyError("The key's private_key cannot be read. Download a new key.");
  }
  return parsed.data;
}

export function serviceAccountSummary(key: ServiceAccountKey): ServiceAccountSummary {
  return { clientEmail: key.client_email, projectId: key.project_id, keyId: key.private_key_id };
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Google refused the key itself (revoked, deleted, disabled account). */
export class GoogleAuthError extends Error {
  override name = 'GoogleAuthError';
}

/**
 * Access tokens for one key: a Google `JWT` client per scope, which signs the assertion, calls the
 * token endpoint and caches the token until shortly before it expires.
 */
export class ServiceAccountTokens {
  readonly #key: ServiceAccountKey;
  readonly #fetch: FetchLike | undefined;
  readonly #clients = new Map<string, JWT>();

  constructor(key: ServiceAccountKey, options: { fetch?: FetchLike } = {}) {
    this.#key = key;
    this.#fetch = options.fetch;
  }

  #client(scope: GoogleScope): JWT {
    let client = this.#clients.get(scope);
    if (!client) {
      client = new JWT({
        email: this.#key.client_email,
        key: this.#key.private_key,
        keyId: this.#key.private_key_id,
        scopes: [scope],
        // Tests answer for Google; production uses the library's own fetch.
        ...(this.#fetch ? { transporterOptions: { fetchImplementation: this.#fetch as typeof fetch } } : {}),
      });
      this.#clients.set(scope, client);
    }
    return client;
  }

  async token(scope: GoogleScope): Promise<string> {
    let token: string | null | undefined;
    try {
      token = (await this.#client(scope).getAccessToken()).token;
    } catch (error) {
      // Only Google's error code and description: the response never echoes the key.
      const response = (error as { response?: { status?: number; data?: { error?: string; error_description?: string } } }).response;
      const code = response?.data?.error ?? response?.status ?? 'unreachable';
      const description = response?.data?.error_description;
      throw new GoogleAuthError(
        `Google refused the service account key (${code}${description ? `: ${description}` : ''}). ` +
          'The key may be deleted or the account disabled; upload a new key.',
      );
    }
    if (!token) throw new GoogleAuthError('Google returned no access token for the service account key.');
    return token;
  }
}
