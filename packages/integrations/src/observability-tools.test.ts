import { RequestContext } from '@mastra/core/request-context';
import { describe, expect, it } from 'vitest';

import { ObservabilityProviderError } from '@factory/capabilities';
import type { ObservabilityProvider, ObservabilityScope, ObservabilitySource } from '@factory/capabilities';

import { createObservabilityTools } from './observability-tools.ts';

const now = new Date('2026-11-11T12:00:00Z');

function context(state: { factoryProjectId?: string } = { factoryProjectId: 'factory-1' }, orgId: string | null = 'org-1') {
  const requestContext = new RequestContext();
  if (orgId) requestContext.set('user', { id: 'user-1', organizationId: orgId });
  requestContext.set('controller', { sessionId: 's-1', resourceId: 's-1', threadId: 't-1', getState: () => state });
  return requestContext;
}

function dummySource(features: ObservabilitySource['features'], calls: unknown[] = []): ObservabilitySource {
  return {
    provider: 'dummy',
    features,
    apps: [{ appId: '1:1:android:ab', platform: 'android' }],
    queryLogs: async input => {
      calls.push(input);
      return {
        entries: [
          { timestamp: now.toISOString(), severity: 'ERROR', resourceType: null, service: 'api', message: 'boom' },
          { timestamp: now.toISOString(), severity: 'ERROR', resourceType: null, service: 'api', message: 'boom 2' },
        ],
        nextPageToken: null,
      };
    },
    listCrashIssues: async input => {
      calls.push(input);
      throw new ObservabilityProviderError('Crashlytics refused the service account', {
        status: 403,
        missingRole: 'roles/firebasecrashlytics.viewer',
        fix: 'Grant roles/firebasecrashlytics.viewer.',
      });
    },
    getCrashIssue: async () => {
      throw new Error('not used');
    },
  };
}

function provider(source: ObservabilitySource | null, scopes: ObservabilityScope[] = []): ObservabilityProvider {
  return {
    provider: 'dummy',
    sourceFor: async scope => {
      scopes.push(scope);
      return source;
    },
  };
}

type Runnable = { execute: (input: unknown, context: unknown) => Promise<any> };

describe('createObservabilityTools', () => {
  it('gives no tools to a session without a Factory, an org, or a connected source', async () => {
    const source = dummySource({ logs: true, crashes: true });
    expect(await createObservabilityTools({ requestContext: context({}), provider: provider(source) })).toEqual({});
    expect(await createObservabilityTools({ requestContext: context(undefined, null), provider: provider(source) })).toEqual({});
    expect(await createObservabilityTools({ requestContext: context(), provider: provider(null) })).toEqual({});
    expect(await createObservabilityTools({ requestContext: undefined, provider: provider(source) })).toEqual({});
  });

  it('asks the provider for the session\'s own org and Factory', async () => {
    const scopes: ObservabilityScope[] = [];
    await createObservabilityTools({ requestContext: context(), provider: provider(null, scopes) });
    expect(scopes).toEqual([{ orgId: 'org-1', factoryProjectId: 'factory-1' }]);
  });

  it('offers only the tools of the features the source has', async () => {
    const logsOnly = await createObservabilityTools({ requestContext: context(), provider: provider(dummySource({ logs: true, crashes: false })) });
    expect(Object.keys(logsOnly)).toEqual(['observability_query_logs']);
    const crashesOnly = await createObservabilityTools({ requestContext: context(), provider: provider(dummySource({ logs: false, crashes: true })) });
    expect(Object.keys(crashesOnly).sort()).toEqual(['observability_crash_issue', 'observability_crash_issues']);
  });

  it('reads logs over the last 24 hours by default, counts by severity and marks the data untrusted', async () => {
    const calls: any[] = [];
    const tools = await createObservabilityTools({
      requestContext: context(),
      provider: provider(dummySource({ logs: true, crashes: false }, calls)),
      now: () => now,
    });
    const result = await (tools.observability_query_logs as Runnable).execute({ severityAtLeast: 'ERROR' }, {});
    expect(calls[0]).toMatchObject({ severityAtLeast: 'ERROR', limit: 50, to: now, from: new Date(now.getTime() - 24 * 3_600_000) });
    expect(result).toMatchObject({ count: 2, bySeverity: { ERROR: 2 }, nextPageToken: null });
    expect(result.note).toMatch(/untrusted/);
  });

  it('returns a provider refusal with the role to grant instead of failing the turn', async () => {
    const tools = await createObservabilityTools({ requestContext: context(), provider: provider(dummySource({ logs: false, crashes: true })), now: () => now });
    const result = await (tools.observability_crash_issues as Runnable).execute({}, {});
    expect(result).toMatchObject({ missingRole: 'roles/firebasecrashlytics.viewer' });
    expect(result.fix).toContain('admin in Google Cloud');
  });
});
