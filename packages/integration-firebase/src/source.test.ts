import { describe, expect, it } from 'vitest';

import { ObservabilityProviderError } from '@factory/capabilities';
import {
  OBSERVABILITY_CONTRACT_NOW,
  describeObservabilitySourceContract,
  observabilityContractSeed,
} from '@factory/capabilities/observability-contract';

import { buildLogFilter } from './logging.ts';
import { FirebaseObservabilitySource } from './source.ts';
import { fakeGoogle, fakeServiceAccountKey } from './testing.ts';

const now = () => OBSERVABILITY_CONTRACT_NOW;
const window = { from: new Date(now().getTime() - 86_400_000), to: now() };

function source(seed = observabilityContractSeed(), options: Parameters<typeof fakeGoogle>[1] = {}, logs = true, withApps = true) {
  const google = fakeGoogle(seed, options);
  return {
    google,
    source: new FirebaseObservabilitySource({
      key: fakeServiceAccountKey(),
      mapping: {
        projectId: 'syncta-prod',
        projectNumber: '1234567890',
        logs,
        apps: withApps ? seed.apps.map(app => ({ ...app })) : [],
      },
      fetch: google.fetch,
      now,
    }),
  };
}

describeObservabilitySourceContract('FirebaseObservabilitySource', async seed => source(seed).source, {
  features: { logs: true, crashes: true },
});
describeObservabilitySourceContract('FirebaseObservabilitySource without apps', async seed => source(seed, {}, true, false).source, {
  features: { logs: true, crashes: false },
});
describe('FirebaseObservabilitySource with crashes switched off', () => {
  it('reads no crashes though apps are mapped', async () => {
    const seed = observabilityContractSeed();
    const firebase = new FirebaseObservabilitySource({
      key: fakeServiceAccountKey(),
      mapping: { projectId: 'syncta-prod', logs: true, crashes: false, apps: seed.apps.map(app => ({ ...app })) },
      fetch: fakeGoogle(seed).fetch,
      now,
    });
    expect(firebase.features).toEqual({ logs: true, crashes: false });
    await expect(firebase.listCrashIssues({ ...window, limit: 1 })).rejects.toThrow(/No app is mapped for crashes/);
  });
});
describeObservabilitySourceContract('FirebaseObservabilitySource crashes only', async seed => source(seed, {}, false, true).source, {
  features: { logs: false, crashes: true },
});

describe('FirebaseObservabilitySource on the wire', () => {
  it('reads logs with a logging.read token, newest first, from the mapped project', async () => {
    const { source: firebase, google } = source();
    await firebase.queryLogs({ ...window, severityAtLeast: 'ERROR', service: 'bookings-api', limit: 5 });
    const token = google.calls.find(call => call.url.includes('oauth2'));
    expect(String(token?.body)).toContain('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer');
    const call = google.calls.find(candidate => candidate.url.includes('entries:list'));
    expect(call?.authorization).toBe('Bearer ya29.fake-access-token-for-tests-only');
    expect(call?.body).toMatchObject({ resourceNames: ['projects/syncta-prod'], orderBy: 'timestamp desc', pageSize: 5 });
  });

  it('drops the query string of request URLs', async () => {
    const { source: firebase } = source();
    const page = await firebase.queryLogs({ ...window, limit: 1 });
    expect(page.entries[0]?.request).toBe('POST 500 /bookings');
  });

  it('addresses Crashlytics by project number and app, and never returns the user id', async () => {
    const { source: firebase, google } = source();
    const issue = await firebase.getCrashIssue({ ...window, issueId: 'issue-1', eventsLimit: 2 });
    expect(google.calls.some(call => call.url.startsWith('https://firebasecrashlytics.googleapis.com/v1alpha/projects/1234567890/apps/'))).toBe(true);
    expect(JSON.stringify(issue)).not.toContain('user-123');
    expect(issue.events[0]?.customKeys).toEqual({ userEmail: '[email]', screen: 'booking' });
    expect(issue.events[0]?.frames[0]).toMatchObject({ symbol: 'com.syncta.Frame0', file: 'Booking.kt', line: 1 });
  });

  it('names the missing role when Google refuses, and the API when it is disabled', async () => {
    const refused = source(observabilityContractSeed(), {
      fail: { logging: { status: 403, body: { error: { code: 403, message: 'Permission denied', status: 'PERMISSION_DENIED' } } } },
    }).source;
    await expect(refused.queryLogs({ ...window, limit: 1 })).rejects.toMatchObject({
      missingRole: 'roles/logging.viewer',
    });
    const disabled = source(observabilityContractSeed(), {
      fail: {
        crashlytics: {
          status: 403,
          body: { error: { code: 403, message: 'API has not been used in project 1234567890', details: [{ reason: 'SERVICE_DISABLED' }] } },
        },
      },
    }).source;
    const error = await disabled.listCrashIssues({ ...window, limit: 1 }).catch(caught => caught);
    expect(error).toBeInstanceOf(ObservabilityProviderError);
    expect(error.fix).toContain('firebasecrashlytics.googleapis.com');
  });

  it('turns a refused key into a provider error that says to upload a new key, without echoing it', async () => {
    const { source: firebase } = source(observabilityContractSeed(), {
      fail: { token: { status: 400, body: { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' } } },
    });
    const error = await firebase.queryLogs({ ...window, limit: 1 }).catch(caught => caught);
    expect(error).toBeInstanceOf(ObservabilityProviderError);
    expect(error.message).toContain('invalid_grant');
    expect(error.message).not.toContain('PRIVATE KEY');
  });
});

describe('buildLogFilter', () => {
  it('escapes free text and never lets it close the literal', () => {
    const filter = buildLogFilter({ ...window, text: 'a" OR severity>=DEBUG OR "b', limit: 1 });
    expect(filter).toContain('"a\\" OR severity>=DEBUG OR \\"b"');
  });

  it('refuses a service name the filter language would read as syntax', () => {
    expect(() => buildLogFilter({ ...window, service: 'api" OR "x', limit: 1 })).toThrow(/service/);
  });
});
