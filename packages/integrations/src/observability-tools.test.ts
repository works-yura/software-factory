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
    expect(Object.keys(logsOnly)).toEqual(['observability_query_logs', 'observability_log_groups']);
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

  it('passes an HTTP status floor to the provider', async () => {
    const calls: any[] = [];
    const tools = await createObservabilityTools({
      requestContext: context(),
      provider: provider([dummySource({ logs: true, crashes: false }, calls)]),
      now: () => now,
    });
    await (tools.observability_query_logs as Runnable).execute({ httpStatusAtLeast: 500 }, {});
    expect(calls[0]).toMatchObject({ httpStatusAtLeast: 500 });
  });

  describe('observability_log_groups', () => {
    /** A source with `total` WARNING entries, `perPage` a page, two kinds of message. */
    function pagedSource(total: number, calls: any[]): ObservabilitySource {
      const all = Array.from({ length: total }, (_, index) => ({
        timestamp: new Date(now.getTime() - index * 60_000).toISOString(),
        severity: 'WARNING' as const,
        resourceType: null,
        service: index % 3 === 0 ? 'webhook' : 'aiagenttask',
        message: index % 3 === 0 ? `RetryLater chat ${index}` : `timeout after ${index} s`,
      }));
      return {
        ...dummySource({ logs: true, crashes: false }),
        queryLogs: async input => {
          calls.push(input);
          const start = input.pageToken ? Number(input.pageToken) : 0;
          const end = Math.min(all.length, start + input.limit);
          return { entries: all.slice(start, end), nextPageToken: end < all.length ? String(end) : null };
        },
      };
    }

    const run = async (source: ObservabilitySource, input: unknown) => {
      const tools = await createObservabilityTools({ requestContext: context(), provider: provider([source]), now: () => now });
      return (tools.observability_log_groups as Runnable).execute(input, {});
    };

    it('pages through every entry and returns counts and groups instead of lines', async () => {
      const calls: any[] = [];
      const result = await run(pagedSource(250, calls), { severityAtLeast: 'WARNING', httpStatusAtLeast: 500 });
      expect(calls.map(call => call.limit)).toEqual([100, 100, 100]);
      expect(calls[0]).toMatchObject({ severityAtLeast: 'WARNING', httpStatusAtLeast: 500, from: new Date(now.getTime() - 24 * 3_600_000), to: now });
      expect(result).toMatchObject({ project: 'syncta-prod', read: 250, complete: true, bySeverity: { WARNING: 250 } });
      expect(result.byService).toEqual({ webhook: 84, aiagenttask: 166 });
      expect(result.groups.map((group: any) => [group.pattern, group.count])).toEqual([
        ['timeout after <n> s', 166],
        ['RetryLater chat <n>', 84],
      ]);
      expect(result.entries).toBeUndefined();
      expect(result.note).toMatch(/untrusted/);
    });

    it('stops at maxEntries and says the count is incomplete', async () => {
      const calls: any[] = [];
      const result = await run(pagedSource(250, calls), { maxEntries: 120, top: 1 });
      expect(calls.map(call => call.limit)).toEqual([100, 20]);
      expect(result).toMatchObject({ read: 120, complete: false, groupsTotal: 2 });
      expect(result.groups).toHaveLength(1);
    });

    it('stops after a bounded number of pages when the provider keeps returning empty ones', async () => {
      let page = 0;
      const sparse: ObservabilitySource = {
        ...dummySource({ logs: true, crashes: false }),
        queryLogs: async () => ({ entries: [], nextPageToken: String((page += 1)) }),
      };
      expect(await run(sparse, {})).toMatchObject({ read: 0, complete: false });
      expect(page).toBe(100);
    });

    it('refuses a provider that loops on one page token', async () => {
      const looping: ObservabilitySource = {
        ...dummySource({ logs: true, crashes: false }),
        queryLogs: async () => ({ entries: [], nextPageToken: 'same' }),
      };
      expect((await run(looping, {})).error).toMatch(/same page token/);
    });
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
