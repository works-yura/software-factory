// GitHub through the connector conformance kit (`@factory/integrations/testing`): a token connection
// seeded through the registry against a fake api.github.com.
import { vi } from 'vitest';

import { createStateSigner } from '@factory/auth';
import { fakeRouteAuth } from '@factory/http/testing';
import { describeConnectorContract } from '@factory/integrations/testing';
import { createFactoryStorageForTests } from '@factory/testing';

import { GithubIntegration } from './integration.ts';

const TOKEN = 'ghp_contract_secret_token';
const account = { id: 4242, login: 'Yura', type: 'User' };
const repo = { id: 1, full_name: 'yura/app', name: 'app', owner: { login: 'yura' }, default_branch: 'main', private: true, permissions: { admin: false, push: true, pull: true } };

function fakeGithub(): typeof fetch {
  const routes: Record<string, unknown> = { 'GET /user': account, 'GET /user/repos': [repo], 'GET /user/installations': { installations: [] } };
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const key = `${(init?.method ?? 'GET').toUpperCase()} ${url.pathname}`;
    return key in routes
      ? new Response(JSON.stringify(routes[key]), { status: 200, headers: { 'content-type': 'application/json' } })
      : new Response(JSON.stringify({ message: `unexpected ${key}` }), { status: 404, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}

describeConnectorContract('GitHub', async () => {
  const seeded = await createFactoryStorageForTests();
  const integration = new GithubIntegration({ fetchImpl: fakeGithub() });
  const context = {
    auth: fakeRouteAuth(),
    sandbox: (() => ({})) as never,
    stateSigner: createStateSigner('secret'),
    hooks: { emitAudit: async () => {} },
    storage: {
      generic: seeded.integrations.forIntegration('github'),
      sourceControl: seeded.sourceControl.forIntegration('github'),
      projects: seeded.projects,
      intake: seeded.intake,
      memorySettings: { get: async () => null },
    },
  } as never;
  integration.routes(context);
  integration.versionControl.initialize({ storage: seeded.sourceControl.forIntegration('github') });
  return {
    registration: { id: 'github', connections: integration.connections(context) },
    orgId: 'org-1',
    admin: 'admin',
    member: 'member',
    secrets: [TOKEN],
    expectsConnections: true,
    seed: async ({ send }) => {
      const connected = await send('admin', 'POST', '/web/connections', { connector: 'github', method: 'token', input: { token: TOKEN } });
      if (connected.status !== 200) throw new Error(`seed failed: ${JSON.stringify(connected.body)}`);
    },
    rename: true,
    remove: true,
  };
});
