import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSourceControlSessionLookup } from '@factory/session';
import { createFactoryStorageForTests } from '@factory/testing';
import { ConfigRoutes } from './config.ts';
import { fakeRouteAuth, mountApiRoutes } from '@factory/http/testing';

async function setup(visibility: 'org' | 'private' = 'org') {
  const seed = await createFactoryStorageForTests();
  const project = await seed.projects.create({
    orgId: 'org-1',
    userId: 'owner',
    input: { name: 'Billing', harnessModelDefaults: { mastra: { instanceId: 'mastra', model: 'deepseek/deepseek-flash' } } },
  });
  const sourceControl = seed.sourceControl.forIntegration('github');
  const installation = await sourceControl.installations.upsert({
    orgId: 'org-1',
    connectedByUserId: 'owner',
    externalId: '123',
  });
  const repository = await sourceControl.repositories.upsert({
    orgId: 'org-1',
    input: { installationId: installation.id, externalId: '456', slug: 'mastra-ai/mastra', defaultBranch: 'main' },
  });
  const connection = await sourceControl.connections.create({
    orgId: 'org-1',
    factoryProjectId: project.id,
    installationId: installation.id,
    createdByUserId: 'owner',
  });
  const projectRepository = await sourceControl.projectRepositories.link({
    orgId: 'org-1',
    connectionId: connection.id,
    repositoryId: repository.id,
    createdByUserId: 'owner',
    sandboxProvider: 'local',
    sandboxWorkdir: '/sandbox/mastra',
  });
  const sourceSession = await sourceControl.sessions.create({
    orgId: 'org-1',
    userId: 'owner',
    factoryProjectId: project.id,
    projectRepositoryId: projectRepository.id,
    sessionId: 'session-1',
    branch: 'test',
    baseBranch: 'main',
    visibility,
  });
  // Personal keys and defaults an older build stored; the catalog never offers them.
  for (const [userId, provider] of [
    ['owner', 'anthropic'],
    ['viewer', 'openai-codex'],
  ] as const) {
    await seed.credentials.setCredential({ orgId: 'org-1', userId }, provider, {
      type: 'api_key',
      key: `${userId}-secret`,
    });
  }
  await seed.credentials.setCredential({ orgId: 'org-1' }, 'deepseek', { type: 'api_key', key: 'org-secret' });
  await seed.modelDefaults.set({ orgId: 'org-1', userId: 'owner', modelId: 'anthropic/claude-opus-4-6' });
  await seed.modelDefaults.set({ orgId: 'org-1', userId: 'viewer', modelId: 'openai/gpt-5.5' });
  let orgId = 'org-1';
  const app = new Hono<{ Variables: { factoryAuthUser: { id: string; organizationId: string } } }>();
  app.use('*', async (c, next) => {
    c.set('factoryAuthUser', { id: 'viewer', organizationId: orgId });
    await next();
  });
  mountApiRoutes(
    app,
    new ConfigRoutes({
      auth: fakeRouteAuth(),
      controller: {
        listAvailableModels: async () => [
          { id: 'anthropic/claude-opus-4-6', provider: 'anthropic', modelName: 'Owner', hasApiKey: false },
          { id: 'openai/gpt-5.5', provider: 'openai', modelName: 'Viewer', hasApiKey: false },
          { id: 'deepseek/deepseek-flash', provider: 'deepseek', modelName: 'Factory', hasApiKey: false },
        ],
      },
      modelCredentials: seed.credentials,
      factoryProjects: seed.projects,
      sourceControlSessions: createSourceControlSessionLookup([sourceControl]),
      workItems: seed.workItems,
    }).routes(),
  );
  const bind = () =>
    seed.workItems.prepareRunStart({
      orgId: 'org-1',
      userId: 'owner',
      factoryProjectId: project.id,
      workItem: {
        input: {
          title: 'Task',
          stages: ['intake'],
          sessions: {},
          metadata: {},
          externalSource: { integrationId: 'github', type: 'issue', externalId: '1' },
        },
      },
      role: 'work',
      session: { sessionId: sourceSession.sessionId, branch: sourceSession.branch, threadId: 'run-thread' },
      resourceId: sourceSession.sessionId,
      kickoffKey: 'run-1',
      kickoffMessage: null,
    });
  return {
    app,
    seed,
    project,
    bind,
    setOrgId: (value: string) => {
      orgId = value;
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe('session-owner model catalog', () => {
  it("uses the Factory catalog and default for a collaborator's interactive session", async () => {
    const { app, project } = await setup();
    // The session runs under its Factory's resource; it is found by its session id.
    const response = await app.request(
      `/web/config/models?sessionId=session-1&resourceId=${project.id}&threadId=chat-thread&scope=user&userId=viewer`,
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).not.toHaveProperty('modelScope');
    expect(body.defaultModelId).toBe('deepseek/deepseek-flash');
    // A live session reads its own policy; the built-in pick is only for a Factory's catalog.
    expect(body).not.toHaveProperty('fallbackModelId');
    expect(body.models).toEqual([
      expect.objectContaining({ id: 'deepseek/deepseek-flash', credentialLabel: 'Deepseek API key' }),
    ]);
    expect(JSON.stringify(body)).not.toContain('secret');
  });

  it.each(['active', 'revoked'] as const)(
    'uses only the Factory catalog and default for an %s work-item thread',
    async status => {
      const { app, seed, project, bind } = await setup();
      await bind();
      if (status === 'revoked')
        await seed.workItems.revokeRunBindingsForWorkItem({
          orgId: 'org-1',
          factoryProjectId: project.id,
          workItemId: (await seed.workItems.findActiveRunBindingByThread({
            orgId: 'org-1',
            resourceId: 'session-1',
            sessionId: 'session-1',
            threadId: 'run-thread',
          }))!.workItemId,
          revokedAt: new Date(),
        });
      const response = await app.request('/web/config/models?resourceId=session-1&threadId=run-thread&scope=user');
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).not.toHaveProperty('modelScope');
      expect(body.defaultModelId).toBe('deepseek/deepseek-flash');
      expect(body.models).toEqual([
        expect.objectContaining({ id: 'deepseek/deepseek-flash', credentialLabel: 'Deepseek API key' }),
      ]);
    },
  );

  it('denies collaborators on private sessions and foreign organizations', async () => {
    const privateSession = await setup('private');
    expect(
      (await privateSession.app.request('/web/config/models?resourceId=session-1&threadId=chat-thread')).status,
    ).toBe(403);
    const foreign = await setup();
    foreign.setOrgId('other-org');
    expect((await foreign.app.request('/web/config/models?resourceId=session-1&threadId=chat-thread')).status).toBe(
      403,
    );
  });

  it('rejects incomplete or unavailable session context instead of returning the viewer catalog', async () => {
    const { app } = await setup();
    expect((await app.request('/web/config/models?resourceId=session-1')).status).toBe(400);
    expect((await app.request('/web/config/models?threadId=chat-thread')).status).toBe(400);
    expect((await app.request('/web/config/models?resourceId=missing&threadId=chat-thread')).status).toBe(403);
  });
});
