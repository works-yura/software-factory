/**
 * A Google service account's key, and OAuth access tokens minted from it (the JWT bearer grant,
 * RFC 7523): no Google SDK, only `node:crypto`. The key never leaves this module except into the
 * encrypted connection row; what anything else sees is `serviceAccountSummary`.
 */

import { createPrivateKey, createSign } from 'node:crypto';

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
} as const;
export type GoogleScope = (typeof GOOGLE_SCOPES)[keyof typeof GOOGLE_SCOPES];

export const serviceAccountKeySchema = z.object({
  type: z.literal('service_account'),
  project_id: z.string().min(1),
  private_key_id: z.string().min(1),
  private_key: z.string().includes('PRIVATE KEY'),
  client_email: z.string().email(),
  token_uri: z.string().optional(),
});
export type ServiceAccountKey = z.infer<typeof serviceAccountKeySchema>;

/** What may be shown about a key: never the key itself. */
export interface ServiceAccountSummary {
  clientEmail: string;
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
  try {
    createPrivateKey(parsed.data.private_key);
  } catch {
    throw new ServiceAccountKeyError('The key\'s private_key cannot be read. Download a new key.');
  }
  return parsed.data;
}

export function serviceAccountSummary(key: ServiceAccountKey): ServiceAccountSummary {
  return { clientEmail: key.client_email, projectId: key.project_id, keyId: key.private_key_id };
}

const base64url = (value: string | Buffer) => Buffer.from(value).toString('base64url');

/** A signed JWT assertion for the token endpoint. */
export function signServiceAccountAssertion(key: ServiceAccountKey, scope: string, now: Date): string {
  const issuedAt = Math.floor(now.getTime() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: key.private_key_id }));
  const claims = base64url(
    JSON.stringify({ iss: key.client_email, scope, aud: GOOGLE_TOKEN_URI, iat: issuedAt, exp: issuedAt + 3600 }),
  );
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  return `${header}.${claims}.${base64url(signer.sign(key.private_key))}`;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Google refused the key itself (revoked, deleted, disabled account). */
export class GoogleAuthError extends Error {
  override name = 'GoogleAuthError';
}

/** Access tokens for one key, cached per scope until a minute before they expire. */
export class ServiceAccountTokens {
  readonly #key: ServiceAccountKey;
  readonly #fetch: FetchLike;
  readonly #now: () => Date;
  readonly #cache = new Map<string, { token: string; expiresAt: number }>();

  constructor(key: ServiceAccountKey, options: { fetch?: FetchLike; now?: () => Date } = {}) {
    this.#key = key;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#now = options.now ?? (() => new Date());
  }

  async token(scope: GoogleScope): Promise<string> {
    const now = this.#now();
    const cached = this.#cache.get(scope);
    if (cached && cached.expiresAt - 60_000 > now.getTime()) return cached.token;
    const response = await this.#fetch(GOOGLE_TOKEN_URI, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: signServiceAccountAssertion(this.#key, scope, now),
      }).toString(),
    });
    const body = (await response.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };
    if (!response.ok || !body.access_token) {
      // Only Google's error code and description: the response never echoes the key.
      throw new GoogleAuthError(
        `Google refused the service account key (${body.error ?? response.status}${
          body.error_description ? `: ${body.error_description}` : ''
        }). The key may be deleted or the account disabled; upload a new key.`,
      );
    }
    this.#cache.set(scope, { token: body.access_token, expiresAt: now.getTime() + (body.expires_in ?? 3600) * 1000 });
    return body.access_token;
  }
}
