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

function dummySource(
  features: ObservabilitySource['features'],
  calls: unknown[] = [],
  target: ObservabilitySource['target'] = { ref: 'bnd-prod', name: 'syncta-prod' },
): ObservabilitySource {
  return {
    provider: 'dummy',
    target,
    features,
    apps: [{ appId: '1:1:android:ab', platform: 'android' }],
    queryLogs: async input => {
      calls.push({ project: target.name, ...input });
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

function provider(sources: ObservabilitySource[], scopes: ObservabilityScope[] = []): ObservabilityProvider {
  return {
    provider: 'dummy',
    sourcesFor: async scope => {
      scopes.push(scope);
      return sources;
    },
  };
}

type Runnable = { execute: (input: unknown, context: unknown) => Promise<any> };

describe('createObservabilityTools', () => {
  it('gives no tools to a session without a Factory, an org, or a bound source', async () => {
    const source = dummySource({ logs: true, crashes: true });
    expect(await createObservabilityTools({ requestContext: context({}), provider: provider([source]) })).toEqual({});
    expect(await createObservabilityTools({ requestContext: context(undefined, null), provider: provider([source]) })).toEqual({});
    expect(await createObservabilityTools({ requestContext: context(), provider: provider([]) })).toEqual({});
    expect(await createObservabilityTools({ requestContext: undefined, provider: provider([source]) })).toEqual({});
  });

  it("asks the provider for the session's own org and Factory", async () => {
    const scopes: ObservabilityScope[] = [];
    await createObservabilityTools({ requestContext: context(), provider: provider([], scopes) });
    expect(scopes).toEqual([{ orgId: 'org-1', factoryProjectId: 'factory-1' }]);
  });

  it('offers only the tools of the features some source has', async () => {
    const logsOnly = await createObservabilityTools({ requestContext: context(), provider: provider([dummySource({ logs: true, crashes: false })]) });
    expect(Object.keys(logsOnly)).toEqual(['observability_query_logs']);
    const crashesOnly = await createObservabilityTools({ requestContext: context(), provider: provider([dummySource({ logs: false, crashes: true })]) });
    expect(Object.keys(crashesOnly).sort()).toEqual(['observability_crash_issue', 'observability_crash_issues']);
  });

  it('reads logs over the last 24 hours by default, counts by severity, names the project and marks the data untrusted', async () => {
    const calls: any[] = [];
    const tools = await createObservabilityTools({
      requestContext: context(),
      provider: provider([dummySource({ logs: true, crashes: false }, calls)]),
      now: () => now,
    });
    const result = await (tools.observability_query_logs as Runnable).execute({ severityAtLeast: 'ERROR' }, {});
    expect(calls[0]).toMatchObject({ severityAtLeast: 'ERROR', limit: 50, to: now, from: new Date(now.getTime() - 24 * 3_600_000) });
    expect(result).toMatchObject({ project: 'syncta-prod', count: 2, bySeverity: { ERROR: 2 }, nextPageToken: null });
    expect(result.note).toMatch(/untrusted/);
  });

  it('returns a provider refusal with the role to grant instead of failing the turn', async () => {
    const tools = await createObservabilityTools({ requestContext: context(), provider: provider([dummySource({ logs: false, crashes: true })]), now: () => now });
    const result = await (tools.observability_crash_issues as Runnable).execute({}, {});
    expect(result).toMatchObject({ missingRole: 'roles/firebasecrashlytics.viewer' });
    expect(result.fix).toContain('admin in Google Cloud');
  });

  describe('with several bound projects', () => {
    const setup = async () => {
      const calls: any[] = [];
      const prod = dummySource({ logs: true, crashes: false }, calls, { ref: 'bnd-prod', name: 'syncta-prod' });
      const staging = dummySource({ logs: true, crashes: false }, calls, { ref: 'bnd-staging', name: 'syncta-staging' });
      const tools = await createObservabilityTools({ requestContext: context(), provider: provider([prod, staging]), now: () => now });
      return { calls, run: (input: unknown) => (tools.observability_query_logs as Runnable).execute(input, {}), tools };
    };

    it('lists every project in the tool description', async () => {
      const { tools } = await setup();
      const description = (tools.observability_query_logs as { description: string }).description;
      expect(description).toContain('syncta-prod');
      expect(description).toContain('syncta-staging');
    });

    it('requires project and names the choices', async () => {
      const { run, calls } = await setup();
      const result = await run({});
      expect(result.error).toMatch(/several projects/);
      expect(result.error).toContain('syncta-prod, syncta-staging');
      expect(calls).toEqual([]);
    });

    it('reads the project named by id or by ref', async () => {
      const { run, calls } = await setup();
      expect(await run({ project: 'syncta-staging' })).toMatchObject({ project: 'syncta-staging' });
      expect(await run({ project: 'bnd-prod' })).toMatchObject({ project: 'syncta-prod' });
      expect(calls.map(call => call.project)).toEqual(['syncta-staging', 'syncta-prod']);
    });

    it('refuses an unknown project without calling the provider', async () => {
      const { run, calls } = await setup();
      const result = await run({ project: 'bookfate-prod' });
      expect(result.error).toMatch(/No logs are read from project "bookfate-prod"/);
      expect(calls).toEqual([]);
    });
  });
});
