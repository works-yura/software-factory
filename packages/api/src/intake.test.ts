import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Intake } from '@factory/capabilities';
import type { AuditEmitter } from '@factory/feed';
import { createFactoryStorageForTests } from '@factory/testing';
import type { FactoryStorageTestSeed } from '@factory/testing';
import { IntakeRoutes, parseIntakeConfig } from './intake.ts';
import { fakeRouteAuth, mountApiRoutes } from '@factory/http/testing';

const auditEvents: Array<Record<string, unknown>> = [];
const audit: AuditEmitter = {
  async emit({ input }) {
    auditEvents.push({
      action: input.action,
      metadata: input.metadata,
      ...(input.factoryProjectId ? { factoryProjectId: input.factoryProjectId } : {}),
    });
  },
};

const github: Pick<Intake, 'listSources'> = {
  listSources: vi.fn(async () => [{ id: 'repo-1', name: 'acme/app', type: 'repository' }]),
};

const gitlab: Pick<Intake, 'listSources'> = {
  listSources: vi.fn(async () => [{ id: 'team-1', name: 'Platform', type: 'project' }]),
};

const integrations = [
  { id: 'github', intake: github },
  { id: 'gitlab', intake: gitlab },
];

function buildApp(user: { id: string; organizationId?: string } | null, intakeIntegrations = integrations) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (user) c.set('factoryAuthUser' as never, user as never);
    await next();
  });
  mountApiRoutes(
    app as any,
    new IntakeRoutes({
      auth: fakeRouteAuth(),
      audit,
      intake: seed.intake,
      integrations: intakeIntegrations,
    }).routes(),
  );
  return app;
}

const orgUser = { id: 'u1', organizationId: 'org1' };

let seed: FactoryStorageTestSeed;

beforeEach(async () => {
  seed = await createFactoryStorageForTests();
  auditEvents.length = 0;
  vi.clearAllMocks();
});

describe('intake configuration', () => {
  it('requires an authenticated organization', async () => {
    expect((await buildApp(null).request('/web/intake/config')).status).toBe(401);
    expect((await buildApp({ id: 'u1' }).request('/web/intake/config')).status).toBe(403);
  });

  it('defaults every configured capability to disabled with no selected sources', async () => {
    const response = await buildApp(orgUser).request('/web/intake/config');
    expect(await response.json()).toEqual({
      config: {
        github: { enabled: false, sourceIds: null },
        gitlab: { enabled: false, sourceIds: null },
      },
    });
  });

  it('persists dynamic integration selections and audits a bounded summary', async () => {
    const config = {
      github: { enabled: true, sourceIds: ['repo-1'] },
      gitlab: { enabled: false, sourceIds: null },
    };
    const response = await buildApp(orgUser).request('/web/intake/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(config),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ config });
    expect(await seed.intake.getConfig({ orgId: 'org1' })).toEqual(config);
    expect(auditEvents).toEqual([
      {
        action: 'factory.intake.config_updated',
        metadata: {
          github: { enabled: true, sources: 1 },
          gitlab: { enabled: false, sources: null },
        },
      },
    ]);
  });

  describe('label routes', () => {
    it('answers 410 Gone: intake routes replaced them', async () => {
      expect((await buildApp(null).request('/web/intake/label-routes')).status).toBe(401);
      for (const method of ['GET', 'PUT'] as const) {
        const response = await buildApp(orgUser).request('/web/intake/label-routes', {
          method,
          ...(method === 'PUT'
            ? {
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ factoryProjectId: 'p', integrationId: 'github', label: 'bug', board: 'release' }),
              }
            : {}),
        });
        expect(response.status).toBe(410);
        expect(await response.json()).toMatchObject({ error: 'label_routes_removed' });
      }
    });
  });

  it('rejects unknown integrations and invalid JSON', async () => {
    const unknown = await buildApp(orgUser).request('/web/intake/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ notion: { enabled: true, sourceIds: null } }),
    });
    expect(unknown.status).toBe(400);

    const invalid = await buildApp(orgUser).request('/web/intake/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: 'bad-json',
    });
    expect(invalid.status).toBe(400);
  });

  it('drops disabled empty entries for unregistered integrations', async () => {
    const response = await buildApp(orgUser, [{ id: 'github', intake: github }]).request('/web/intake/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        github: { enabled: true, sourceIds: ['repo-1'] },
        gitlab: { enabled: false, sourceIds: null },
      }),
    });

    const config = { github: { enabled: true, sourceIds: ['repo-1'] } };
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ config });
    expect(await seed.intake.getConfig({ orgId: 'org1' })).toEqual(config);
    expect(auditEvents).toEqual([
      {
        action: 'factory.intake.config_updated',
        metadata: { github: { enabled: true, sources: 1 } },
      },
    ]);
  });

  it('rejects unregistered integrations with active selections', async () => {
    for (const selection of [
      { enabled: true, sourceIds: null },
      { enabled: false, sourceIds: ['team-1'] },
    ]) {
      const response = await buildApp(orgUser, [{ id: 'github', intake: github }]).request('/web/intake/config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ github: { enabled: true, sourceIds: null }, gitlab: selection }),
      });
      expect(response.status).toBe(400);
    }
  });

  it('rejects an active selection sent under a prototype key', async () => {
    const response = await buildApp(orgUser, [{ id: 'github', intake: github }]).request('/web/intake/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: '{"github":{"enabled":true,"sourceIds":null},"__proto__":{"enabled":true,"sourceIds":["team-1"]}}',
    });

    expect(response.status).toBe(400);
    expect(auditEvents).toEqual([]);
  });
});

describe('aggregated intake', () => {
  it('lists normalized sources from every configured capability', async () => {
    const response = await buildApp(orgUser).request('/web/intake/sources');
    expect(await response.json()).toEqual({
      sources: [
        { integrationId: 'github', id: 'repo-1', name: 'acme/app', type: 'repository' },
        { integrationId: 'gitlab', id: 'team-1', name: 'Platform', type: 'project' },
      ],
      failures: [],
    });
  });

  it("lists only the requested integration's sources without asking the others", async () => {
    const response = await buildApp(orgUser).request('/web/intake/sources?integrationId=github');
    expect(await response.json()).toEqual({
      sources: [{ integrationId: 'github', id: 'repo-1', name: 'acme/app', type: 'repository' }],
      failures: [],
    });
    expect(vi.mocked(gitlab.listSources)).not.toHaveBeenCalled();
  });

  it('keeps listing sources from the capabilities that answer when one is unavailable', async () => {
    vi.mocked(gitlab.listSources).mockRejectedValueOnce(new Error('GitLab token expired'));

    const response = await buildApp(orgUser).request('/web/intake/sources');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      sources: [{ integrationId: 'github', id: 'repo-1', name: 'acme/app', type: 'repository' }],
      failures: [{ integrationId: 'gitlab', message: 'GitLab token expired' }],
    });
  });

  it('gives up on a capability that never answers instead of hanging the listing', async () => {
    vi.useFakeTimers();
    vi.mocked(gitlab.listSources).mockReturnValueOnce(new Promise(() => {}));

    const pending = buildApp(orgUser).request('/web/intake/sources');
    await vi.advanceTimersByTimeAsync(15_000);
    const response = await pending;
    vi.useRealTimers();

    expect(await response.json()).toEqual({
      sources: [{ integrationId: 'github', id: 'repo-1', name: 'acme/app', type: 'repository' }],
      failures: [{ integrationId: 'gitlab', message: 'gitlab did not answer within 15s' }],
    });
  });
});

describe('parseIntakeConfig', () => {
  it('accepts arbitrary integration ids and defaults omitted source lists to null', () => {
    expect(parseIntakeConfig({ gitlab: { enabled: true }, custom: { enabled: false, sourceIds: ['board-1'] } })).toEqual({
      gitlab: { enabled: true, sourceIds: null },
      custom: { enabled: false, sourceIds: ['board-1'] },
    });
  });

  it('accepts encoded source ids up to the selection limit', () => {
    const sourceId = 'gitlab-project:' + 'a'.repeat(900);
    expect(parseIntakeConfig({ gitlab: { enabled: true, sourceIds: [sourceId] } })?.gitlab?.sourceIds).toEqual([
      sourceId,
    ]);
    expect(parseIntakeConfig({ gitlab: { enabled: true, sourceIds: ['a'.repeat(1025)] } })).toBeNull();
  });

  it('rejects malformed or duplicate source ids', () => {
    expect(parseIntakeConfig(null)).toBeNull();
    expect(parseIntakeConfig({ github: { enabled: 'yes' } })).toBeNull();
    expect(parseIntakeConfig({ github: { enabled: true, sourceIds: ['a', 'a'] } })).toBeNull();
  });
});
