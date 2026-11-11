/**
 * Authorized JSON calls to Google APIs, and Google's errors turned into what a person can act on:
 * a permission refusal names the IAM role to grant, a disabled API names the API to enable.
 */

import { ObservabilityProviderError } from '@factory/capabilities';

import { GoogleAuthError } from './service-account.ts';
import type { FetchLike, GoogleScope, ServiceAccountTokens } from './service-account.ts';

/** What one Google API needs, for error messages. */
export interface GoogleApiSpec {
  /** `Cloud Logging`, `Crashlytics`. */
  label: string;
  /** `logging.googleapis.com`. */
  service: string;
  scope: GoogleScope;
  /** The read-only role to grant on a permission refusal. */
  role: string;
}

export const LOGGING_API: GoogleApiSpec = {
  label: 'Cloud Logging',
  service: 'logging.googleapis.com',
  scope: 'https://www.googleapis.com/auth/logging.read',
  role: 'roles/logging.viewer',
};

export const CRASHLYTICS_API: GoogleApiSpec = {
  label: 'Crashlytics',
  service: 'firebasecrashlytics.googleapis.com',
  scope: 'https://www.googleapis.com/auth/firebase',
  role: 'roles/firebasecrashlytics.viewer',
};

interface GoogleErrorBody {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    details?: Array<{ reason?: string; metadata?: Record<string, string> }>;
  };
}

/** Google's error body for one response, as an ObservabilityProviderError. */
export function googleError(api: GoogleApiSpec, status: number, body: GoogleErrorBody, projectId: string): ObservabilityProviderError {
  const message = body.error?.message?.slice(0, 300) ?? `HTTP ${status}`;
  const reasons = (body.error?.details ?? []).map(detail => detail.reason ?? '');
  if (reasons.includes('SERVICE_DISABLED') || /has not been used in project|is disabled/i.test(message)) {
    return new ObservabilityProviderError(`${api.label} API is not enabled in project ${projectId}.`, {
      status,
      fix: `Enable ${api.service} in Google Cloud Console › APIs & Services for project ${projectId}.`,
    });
  }
  if (status === 403) {
    return new ObservabilityProviderError(`${api.label} refused the service account: ${message}`, {
      status,
      missingRole: api.role,
      fix: `Grant ${api.role} to the service account on project ${projectId}.`,
    });
  }
  if (status === 404) {
    return new ObservabilityProviderError(`${api.label} found nothing at that address: ${message}`, {
      status,
      fix: 'Check the Firebase project id and app ids in Settings › Logs and crashes.',
    });
  }
  if (status === 429) {
    return new ObservabilityProviderError(`${api.label} quota exceeded; try again in a minute.`, { status });
  }
  return new ObservabilityProviderError(`${api.label} failed (HTTP ${status}): ${message}`, { status });
}

export interface GoogleApiClientOptions {
  tokens: Pick<ServiceAccountTokens, 'token'>;
  projectId: string;
  fetch?: FetchLike;
}

/** JSON GET/POST against one Google API with a token of its scope. */
export class GoogleApiClient {
  readonly #tokens: Pick<ServiceAccountTokens, 'token'>;
  readonly #fetch: FetchLike;
  readonly projectId: string;

  constructor(options: GoogleApiClientOptions) {
    this.#tokens = options.tokens;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.projectId = options.projectId;
  }

  async request<T>(api: GoogleApiSpec, url: string, init: { method: 'GET' | 'POST'; body?: unknown } = { method: 'GET' }): Promise<T> {
    let token: string;
    try {
      token = await this.#tokens.token(api.scope);
    } catch (error) {
      if (error instanceof GoogleAuthError) throw new ObservabilityProviderError(error.message, { status: 401, fix: 'Upload a new service account key.' });
      throw error;
    }
    const response = await this.#fetch(url, {
      method: init.method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as GoogleErrorBody;
      throw googleError(api, response.status, body, this.projectId);
    }
    return (await response.json()) as T;
  }
}
