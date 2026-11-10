/**
 * Test doubles: a throwaway service account key and a fake Google (token endpoint, Cloud Logging,
 * Crashlytics) answering from an observability contract seed. No real Google API is ever called.
 */

import { generateKeyPairSync } from 'node:crypto';

import type { ObservabilityContractSeed } from '@factory/capabilities/observability-contract';

import { CRASHLYTICS_BASE_URL } from './crashlytics.ts';
import { LOGGING_ENTRIES_URL } from './logging.ts';
import { GOOGLE_TOKEN_URI } from './service-account.ts';
import type { FetchLike, ServiceAccountKey } from './service-account.ts';

let cachedPem: string | undefined;

export function fakeServiceAccountKey(overrides: Partial<ServiceAccountKey> = {}): ServiceAccountKey {
  cachedPem ??= generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  return {
    type: 'service_account',
    project_id: 'syncta-prod',
    private_key_id: 'key-1',
    private_key: cachedPem,
    client_email: 'factory-reader@syncta-prod.iam.gserviceaccount.com',
    token_uri: GOOGLE_TOKEN_URI,
    ...overrides,
  };
}

export interface FakeGoogleCall {
  method: string;
  url: string;
  body: unknown;
  authorization: string | null;
}

export interface FakeGoogleOptions {
  /** Status and Google error body per API, to simulate refusals. */
  fail?: { logging?: { status: number; body: unknown }; crashlytics?: { status: number; body: unknown }; token?: { status: number; body: unknown } };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A fetch that serves the seed in Google's wire format and records every call. */
export function fakeGoogle(seed: ObservabilityContractSeed, options: FakeGoogleOptions = {}): { fetch: FetchLike; calls: FakeGoogleCall[] } {
  const calls: FakeGoogleCall[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === 'string' ? (url === GOOGLE_TOKEN_URI ? init.body : JSON.parse(init.body)) : undefined;
    calls.push({ method: init?.method ?? 'GET', url, body, authorization: headers.get('authorization') });

    if (url === GOOGLE_TOKEN_URI) {
      if (options.fail?.token) return json(options.fail.token.status, options.fail.token.body);
      return json(200, { access_token: 'ya29.fake-access-token-for-tests-only', expires_in: 3600, token_type: 'Bearer' });
    }
    if (url === LOGGING_ENTRIES_URL) {
      if (options.fail?.logging) return json(options.fail.logging.status, options.fail.logging.body);
      const pageSize = (body as { pageSize: number }).pageSize;
      return json(200, {
        entries: seed.logs.slice(0, pageSize).map(log => ({
          timestamp: log.timestamp,
          severity: log.severity,
          resource: { type: 'cloud_run_revision', labels: { service_name: log.service } },
          textPayload: log.message,
          httpRequest: { requestMethod: 'POST', requestUrl: `https://api.syncta.app/bookings?email=${encodeURIComponent('anna.koval@example.com')}`, status: 500 },
        })),
        ...(seed.logs.length > pageSize ? { nextPageToken: 'page-2' } : {}),
      });
    }
    if (url.startsWith(CRASHLYTICS_BASE_URL)) {
      if (options.fail?.crashlytics) return json(options.fail.crashlytics.status, options.fail.crashlytics.body);
      const parsed = new URL(url);
      const appId = decodeURIComponent(parsed.pathname.split('/apps/')[1]?.split('/')[0] ?? '');
      const issueId = parsed.searchParams.get('filter.issue.id');
      const pageSize = Number(parsed.searchParams.get('pageSize') ?? '25');
      const issues = seed.issues.filter(issue => issue.appId === appId && (!issueId || issue.id === issueId));
      if (parsed.pathname.endsWith('/reports/topIssues')) {
        return json(200, {
          groups: issues.slice(0, pageSize).map(issue => ({
            issue: {
              id: issue.id,
              title: issue.title,
              subtitle: issue.subtitle,
              errorType: issue.errorType,
              state: 'OPEN',
              firstSeenVersion: '2.4.0',
              lastSeenVersion: '2.4.1',
              uri: `https://console.firebase.google.com/project/syncta-prod/crashlytics/app/android:x/issues/${issue.id}`,
            },
            metrics: [{ eventsCount: String(issue.eventsCount), impactedUsersCount: String(issue.impactedUsers) }],
          })),
        });
      }
      if (parsed.pathname.endsWith('/events')) {
        return json(200, {
          events: (issues[0]?.events ?? []).slice(0, pageSize).map(event => ({
            name: `projects/1234567890/apps/${appId}/events/${event.id}`,
            eventId: event.id,
            eventTime: event.time,
            version: { displayVersion: '2.4.1' },
            device: { marketingName: 'Pixel 8' },
            operatingSystem: { displayName: 'Android', displayVersion: '15' },
            user: { id: 'user-123' },
            exceptions: [
              {
                type: 'java.lang.NullPointerException',
                title: 'NullPointerException',
                exceptionMessage: event.message,
                blamed: true,
                frames: Array.from({ length: 40 }, (_, index) => ({ symbol: `com.syncta.Frame${index}`, file: 'Booking.kt', line: String(index + 1) })),
              },
            ],
            logs: Array.from({ length: 50 }, () => ({ message: event.log })),
            customKeys: { userEmail: 'anna.koval@example.com', screen: 'booking' },
          })),
        });
      }
    }
    return json(404, { error: { code: 404, message: `No fake for ${url}` } });
  };
  return { fetch, calls };
}
