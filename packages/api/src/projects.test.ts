import { Mastra } from '@mastra/core/mastra';
import { InMemoryStore } from '@mastra/core/storage';
import { FactorySandbox } from '@mastra/core/workspace';
import type { FactorySandboxBuilds, FactorySandboxContext } from '@mastra/core/workspace';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import { boardDefinitionOf } from '@factory/store';
import { workBoard } from '@factory/pipelines';
import { EnvironmentBuildRunner } from '@factory/harness-mastra';
import { scheduleIdFor } from '@factory/harness-mastra';
import { ENVIRONMENT_BUILD_WORKFLOW_ID } from '@factory/harness-mastra';
import type { FactoryStorageTestSeed } from '@factory/testing';
import { createFactoryStorageForTests } from '@factory/testing';
import { FACTORY_ROUTE_CONTRACTS } from '@factory/contracts';
import type { ModelSelection } from '@factory/harness/models/contracts';
import { createHarnessModelRegistry } from '@factory/harness/models/registry';
import { codexStubModels } from '@factory/harness/models/registry.testFixtures';
import { ProjectRoutes } from './projects.ts';
import { fakeRouteAuth, mountApiRoutes } from '@factory/http/testing';

const projectRoutes = (
  seed: FactoryStorageTestSeed,
  versionControlIntegrationIds?: string[],
  sessionRetirement?: ConstructorParameters<typeof ProjectRoutes>[0]['sessionRetirement'],
  resolveRepository?: ConstructorParameters<typeof ProjectRoutes>[0]['resolveRepository'],
  overrides?: Partial<ConstructorParameters<typeof ProjectRoutes>[0]>,
) =>
  new ProjectRoutes({
    auth: fakeRouteAuth(),
    projects: seed.projects,
    sourceControl: seed.sourceControl,
    versionControlIntegrationIds,
    sessionRetirement,
    resolveRepository,
    ...overrides,
  }).routes();

describe('ProjectRoutes', () => {
  it('creates, lists, reads, updates, and deletes a project without integrations', async () => {
    const seed = await createFactoryStorageForTests();
    const app = new Hono();
    app.use('*', async (context, next) => {
      context.set('factoryAuthUser' as never, { id: 'user-1', organizationId: 'org-1' } as never);
      await next();
    });
    mountApiRoutes(app as never, projectRoutes(seed));

    const createdResponse = await app.request('/web/factory/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: ' Platform ', description: ' Core services ' }),
    });
    expect(createdResponse.status).toBe(201);
    const created = (await createdResponse.json()) as {
      project: { id: string; name: string; description: string };
    };
    expect(created.project).toMatchObject({ name: 'Platform', description: 'Core services' });
    expect(created.project).not.toHaveProperty('modelScope');

    const listed = (await (await app.request('/web/factory/projects')).json()) as { projects: Array<{ id: string }> };
    expect(listed.projects.map(project => project.id)).toEqual([created.project.id]);
    expect((await app.request(`/web/factory/projects/${created.project.id}`)).status).toBe(200);

    const updatedResponse = await app.request(`/web/factory/projects/${created.project.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Platform engineering',
        description: null,
      }),
    });
    expect(updatedResponse.status).toBe(200);
    expect((await updatedResponse.json()) as unknown).toMatchObject({
      project: { name: 'Platform engineering', description: null },
    });

    expect((await app.request(`/web/factory/projects/${created.project.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await app.request(`/web/factory/projects/${created.project.id}`)).status).toBe(404);
  });

  it('creates a Claude Code factory and switches harness later; models are set per harness elsewhere', async () => {
    const seed = await createFactoryStorageForTests();
    const app = new Hono();
    app.use('*', async (context, next) => {
      context.set('factoryAuthUser' as never, { id: 'user-1', organizationId: 'org-1' } as never);
      await next();
    });
    mountApiRoutes(app as never, projectRoutes(seed));
    const send = (method: string, path: string, body: unknown) =>
      app.request(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

    // A legacy `claudeCodeModel` is not a project field any more: it is ignored.
    const created = await send('POST', '/web/factory/projects', { name: 'Claude', harness: 'claude-code', claudeCodeModel: 'opus' });
    expect(created.status).toBe(201);
    const { project } = (await created.json()) as { project: { id: string } };
    expect(project).toMatchObject({ harness: 'claude-code', harnessModelDefaults: {} });
    expect(project).not.toHaveProperty('claudeCodeModel');

    const path = `/web/factory/projects/${project.id}`;
    const switched = await send('PATCH', path, { harness: 'mastra' });
    expect(switched.status).toBe(200);
    expect(await switched.json()).toMatchObject({ project: { harness: 'mastra' } });
    expect(await (await send('PATCH', path, { harness: 'codex' })).json()).toMatchObject({ project: { harness: 'codex' } });
    expect((await send('PATCH', path, { harness: 'cursor' })).status).toBe(400);
    // Old clients' model fields alone change nothing: there is no field to update.
    expect((await send('PATCH', path, { defaultModelId: 'openai/gpt-5.5' })).status).toBe(400);
    expect((await send('PATCH', path, { claudeCodeModel: 'haiku' })).status).toBe(400);
  });

  it('reads and switches the agent language, refusing languages it does not offer', async () => {
    const seed = await createFactoryStorageForTests();
    const app = new Hono();
    app.use('*', async (context, next) => {
      context.set('factoryAuthUser' as never, { id: 'user-1', organizationId: 'org-1' } as never);
      await next();
    });
    mountApiRoutes(app as never, projectRoutes(seed));
    const send = (method: string, path: string, body: unknown) =>
      app.request(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

    const created = await send('POST', '/web/factory/projects', { name: 'Lang' });
    const { project } = (await created.json()) as { project: { id: string; agentLanguage: string } };
    expect(project.agentLanguage).toBe('uk');

    const path = `/web/factory/projects/${project.id}`;
    const english = await send('PATCH', path, { agentLanguage: 'en' });
    expect(english.status).toBe(200);
    expect(await english.json()).toMatchObject({ project: { agentLanguage: 'en' } });
    expect((await send('PATCH', path, { agentLanguage: 'de' })).status).toBe(400);
    expect((await send('POST', '/web/factory/projects', { name: 'Bad', agentLanguage: 'fr' })).status).toBe(400);
  });

  it('treats the removed slackWorkItemsEnabled setting from an old client as an unknown field', async () => {
    const seed = await createFactoryStorageForTests();
    const project = await seed.projects.create({ orgId: 'org-1', userId: 'user-1', input: { name: 'Platform' } });
    const app = new Hono();
    app.use('*', async (context, next) => {
      context.set('factoryAuthUser' as never, { id: 'user-1', organizationId: 'org-1' } as never);
      await next();
    });
    mountApiRoutes(app as never, projectRoutes(seed));
    const patch = (body: unknown) =>
      app.request(`/web/factory/projects/${project.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    // Sent alone it is an empty update.
    expect((await patch({ slackWorkItemsEnabled: true })).status).toBe(400);

    // Sent with other fields it is ignored.
    const mixed = await patch({ name: 'Renamed', slackWorkItemsEnabled: true });
    expect(mixed.status).toBe(200);
    const { project: updated } = (await mixed.json()) as { project: Record<string, unknown> };
    expect(updated.name).toBe('Renamed');
    expect(updated).not.toHaveProperty('slackWorkItemsEnabled');
  });

  it('accepts and ignores the retired automation switches from an old client, and changes no board', async () => {
    const seed = await createFactoryStorageForTests();
    const project = await seed.projects.create({ orgId: 'org-1', userId: 'user-1', input: { name: 'Platform' } });
    const scope = { orgId: 'org-1', factoryProjectId: project.id };
    await seed.storedBoards.insertIfMissing(scope, boardDefinitionOf(workBoard), 'factory');
    const boardBefore = await seed.storedBoards.get(scope, 'work');
    const app = new Hono();
    app.use('*', async (context, next) => {
      context.set('factoryAuthUser' as never, { workosId: 'user-1', organizationId: 'org-1' } as never);
      await next();
    });
    mountApiRoutes(app as never, projectRoutes(seed));
    const patch = (body: unknown) =>
      app.request(`/web/factory/projects/${project.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    // An old Board settings toggle still gets a 200, so it does not show an error; the board's
    // phases own automation now, so nothing is stored or returned.
    for (const field of ['autoApprovePlans', 'autoRunEnabled', 'selfReviewEnabled']) {
      const alone = await patch({ [field]: true });
      expect(alone.status, field).toBe(200);
      expect(((await alone.json()) as { project: Record<string, unknown> }).project).not.toHaveProperty(field);

      const mixed = await patch({ name: `Renamed ${field}`, [field]: true });
      expect(mixed.status, field).toBe(200);
      const { project: updated } = (await mixed.json()) as { project: Record<string, unknown> };
      expect(updated.name).toBe(`Renamed ${field}`);
      expect(updated).not.toHaveProperty(field);
    }
    expect(await seed.projects.retiredAutomationSettings({ orgId: 'org-1', id: project.id })).toEqual({
      autoRunEnabled: false,
      selfReviewEnabled: false,
    });
    expect(await seed.storedBoards.get(scope, 'work')).toEqual(boardBefore);
  });

  it('accepts and ignores the retired reviewTestChecksEnabled switch from an old client', async () => {
    const seed = await createFactoryStorageForTests();
    const project = await seed.projects.create({ orgId: 'org-1', userId: 'user-1', input: { name: 'Platform' } });
    const app = new Hono();
    app.use('*', async (context, next) => {
      context.set('factoryAuthUser' as never, { workosId: 'user-1', organizationId: 'org-1' } as never);
      await next();
    });
    mountApiRoutes(app as never, projectRoutes(seed));
    const patch = (body: unknown) =>
      app.request(`/web/factory/projects/${project.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    // The review skill decides whether to publish its test check, so the old toggle
    // gets a 200 and changes nothing.
    const alone = await patch({ reviewTestChecksEnabled: true });
    expect(alone.status).toBe(200);
    expect(((await alone.json()) as { project: Record<string, unknown> }).project).not.toHaveProperty(
      'reviewTestChecksEnabled',
    );

    const mixed = await patch({ name: 'Renamed', reviewTestChecksEnabled: false });
    expect(mixed.status).toBe(200);
    const { project: updated } = (await mixed.json()) as { project: Record<string, unknown> };
    expect(updated.name).toBe('Renamed');
    expect(updated).not.toHaveProperty('reviewTestChecksEnabled');
    expect(await seed.projects.get({ orgId: 'org-1', id: project.id })).not.toHaveProperty('reviewTestChecksEnabled');
  });

  it('requires an organization and scopes project access by organization', async () => {
    const seed = await createFactoryStorageForTests();
    const project = await seed.projects.create({ orgId: 'org-1', userId: 'user-1', input: { name: 'Private' } });
    const buildApp = (user?: { id: string; organizationId?: string }) => {
      const app = new Hono();
      app.use('*', async (context, next) => {
        if (user) context.set('factoryAuthUser' as never, user as never);
        await next();
      });
      mountApiRoutes(app as never, projectRoutes(seed));
      return app;
    };

    expect((await buildApp().request('/web/factory/projects')).status).toBe(401);
    expect((await buildApp({ id: 'user-1' }).request('/web/factory/projects')).status).toBe(403);
    const otherOrg = buildApp({ id: 'user-2', organizationId: 'org-2' });
    expect((await otherOrg.request(`/web/factory/projects/${project.id}`)).status).toBe(404);
    expect(
      (
        await otherOrg.request(`/web/factory/projects/${project.id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'Taken over' }),
        })
      ).status,
    ).toBe(404);
  });

  it('ignores a model scope sent by an old client, admin or not', async () => {
    const seed = await createFactoryStorageForTests();
    const project = await seed.projects.create({ orgId: 'org-1', userId: 'user-1', input: { name: 'Shared' } });
    const isOrganizationAdmin = vi.fn(async () => false);
    const app = new Hono();
    app.use('*', async (context, next) => {
      context.set('factoryAuthUser' as never, { id: 'member', organizationId: 'org-1' } as never);
      await next();
    });
    mountApiRoutes(
      app as never,
      projectRoutes(seed, undefined, undefined, undefined, { auth: fakeRouteAuth({ isOrganizationAdmin }) }),
    );
    const patch = (body: Record<string, unknown>) =>
      app.request(`/web/factory/projects/${project.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    // There is no model scope to change: alone it is an empty update, with other fields it is ignored.
    const ignored = await patch({ modelScope: 'user' });
    expect(ignored.status).toBe(400);
    expect(await ignored.json()).toEqual({ error: 'invalid_project' });
    expect(isOrganizationAdmin).not.toHaveBeenCalled();

    const renamed = await patch({ name: 'Renamed', modelScope: 'user' });
    expect(renamed.status).toBe(200);
    expect(((await renamed.json()) as { project: Record<string, unknown> }).project).not.toHaveProperty('modelScope');
    expect(await seed.projects.getById({ id: project.id })).not.toHaveProperty('modelScope');
  });

  describe('model defaults per harness instance', () => {
    type ApplyContext = { factoryProjectId: string; stillCurrent?: () => Promise<boolean> };
    type ApplyResult = { applied: string[]; skipped: Array<{ threadId: string; reason: string }> };
    const setup = async (
      options: {
        admin?: boolean;
        withApply?: boolean;
        apply?: (selection: ModelSelection, ctx: ApplyContext) => Promise<ApplyResult>;
      } = {},
    ) => {
      const seed = await createFactoryStorageForTests();
      const project = await seed.projects.create({ orgId: 'org-1', userId: 'user-1', input: { name: 'Shared' } });
      const isOrganizationAdmin = vi.fn(async () => options.admin ?? true);
      // A third harness the routes know nothing about, beside a stub of Claude Code's catalog.
      const factoryDefaults = { current: {} as Record<string, ModelSelection> };
      const codex = codexStubModels(new Set(), factoryDefaults);
      const applyDefaultToRunningSessions = vi.fn(
        options.apply ??
          (async (_selection: ModelSelection, _ctx: ApplyContext): Promise<ApplyResult> => ({
            applied: ['thread-1'],
            skipped: [{ threadId: 'thread-2', reason: 'not-running' }],
          })),
      );
      const registry = createHarnessModelRegistry([
        options.withApply ? { ...codex, applyDefaultToRunningSessions } : codex,
      ]);
      const app = new Hono();
      app.use('*', async (context, next) => {
        context.set('factoryAuthUser' as never, { id: 'member', organizationId: 'org-1' } as never);
        await next();
      });
      mountApiRoutes(
        app as never,
        projectRoutes(seed, undefined, undefined, undefined, {
          auth: fakeRouteAuth({ isOrganizationAdmin }),
          harnessModels: () => registry,
        }),
      );
      const send = (method: string, instanceId: string, body?: unknown, suffix = '') =>
        app.request(`/web/factory/projects/${project.id}/model-defaults/${instanceId}${suffix}`, {
          method,
          headers: { 'content-type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      return { seed, project, send, isOrganizationAdmin, applyDefaultToRunningSessions };
    };

    it("sets one instance's default, checked by that harness's facet, and clears it", async () => {
      const { seed, project, send } = await setup();
      const fast = { model: 'gpt-5.3-codex', options: [{ id: 'reasoningEffort', value: 'high' }, { id: 'fastMode', value: true }] };
      const saved = await send('PUT', 'codex-stub', fast);
      expect(saved.status).toBe(200);
      const selection = { instanceId: 'codex-stub', ...fast };
      expect(await saved.json()).toMatchObject({ selection, project: { harnessModelDefaults: { 'codex-stub': selection } } });
      expect((await seed.projects.getById({ id: project.id }))?.harnessModelDefaults).toEqual({ 'codex-stub': selection });

      // The facet refuses what its catalog does not offer; nothing is stored.
      const unknownOption = await send('PUT', 'codex-stub', { model: 'gpt-5-mini', options: [{ id: 'reasoningEffort', value: 'high' }] });
      expect(unknownOption.status).toBe(400);
      expect(await unknownOption.json()).toMatchObject({
        error: 'invalid_model_default',
        message: expect.stringMatching(/gpt-5-mini has no option reasoningEffort/),
      });
      expect((await send('PUT', 'codex-stub', { model: 'o3' })).status).toBe(400);
      expect((await send('PUT', 'codex-stub', { options: [] })).status).toBe(400);
      expect((await seed.projects.getById({ id: project.id }))?.harnessModelDefaults).toEqual({ 'codex-stub': selection });

      // An instance no harness on this server runs.
      expect(await (await send('PUT', 'gemini', { model: 'x' })).json()).toMatchObject({ error: 'unknown_instance' });

      const cleared = await send('DELETE', 'codex-stub');
      expect(cleared.status).toBe(200);
      expect(await cleared.json()).toMatchObject({ project: { harnessModelDefaults: {} } });
    });

    it('keeps the other instances when one changes', async () => {
      const { seed, project, send } = await setup();
      const mastra = { instanceId: 'mastra', model: 'openai/gpt-5.5' };
      await seed.projects.update({ orgId: 'org-1', id: project.id, input: { harnessModelDefaults: { mastra } } });
      await send('PUT', 'codex-stub', { model: 'gpt-5-mini' });
      expect((await seed.projects.getById({ id: project.id }))?.harnessModelDefaults).toEqual({
        mastra,
        'codex-stub': { instanceId: 'codex-stub', model: 'gpt-5-mini' },
      });
      await send('DELETE', 'codex-stub');
      expect((await seed.projects.getById({ id: project.id }))?.harnessModelDefaults).toEqual({ mastra });
    });

    it('is admin-only', async () => {
      const { seed, project, send } = await setup({ admin: false });
      const denied = await send('PUT', 'codex-stub', { model: 'gpt-5-mini' });
      expect(denied.status).toBe(403);
      expect(await denied.json()).toEqual({
        error: 'forbidden',
        message: 'Organization administrator access is required to change the default model.',
      });
      expect((await send('DELETE', 'codex-stub')).status).toBe(403);
      expect((await send('POST', 'codex-stub', undefined, '/apply')).status).toBe(403);
      expect((await seed.projects.getById({ id: project.id }))?.harnessModelDefaults).toEqual({});
    });

    it("moves running sessions onto the default through the facet, when it can", async () => {
      const withApply = await setup({ withApply: true });
      const unset = await withApply.send('POST', 'codex-stub', undefined, '/apply');
      expect(unset.status).toBe(400);
      expect(await unset.json()).toMatchObject({ error: 'default_model_not_set' });

      await withApply.send('PUT', 'codex-stub', { model: 'gpt-5-mini' });
      const completed = vi.spyOn(console, 'info').mockImplementation(() => {});
      try {
        // Acknowledged at once; the facet switches the sessions in the background.
        const applied = await withApply.send('POST', 'codex-stub', undefined, '/apply');
        expect(applied.status).toBe(202);
        expect(await applied.json()).toEqual({
          selection: { instanceId: 'codex-stub', model: 'gpt-5-mini' },
          status: 'started',
        });
        await vi.waitFor(() =>
          expect(withApply.applyDefaultToRunningSessions).toHaveBeenCalledWith(
            { instanceId: 'codex-stub', model: 'gpt-5-mini' },
            {
              viewer: { userId: 'member', orgId: 'org-1' },
              factoryProjectId: withApply.project.id,
              stillCurrent: expect.any(Function),
            },
          ),
        );
        await vi.waitFor(() =>
          expect(completed).toHaveBeenCalledWith('[factory] apply-default-model completed', {
            projectId: withApply.project.id,
            instanceId: 'codex-stub',
            model: 'gpt-5-mini',
            applied: 1,
            skipped: 1,
          }),
        );
      } finally {
        completed.mockRestore();
      }

      const without = await setup();
      await without.send('PUT', 'codex-stub', { model: 'gpt-5-mini' });
      expect(await (await without.send('POST', 'codex-stub', undefined, '/apply')).json()).toMatchObject({
        error: 'model_apply_unavailable',
      });
    });

    it('runs one apply at a time per instance, and an older one stops once the default moved on', async () => {
      let releaseFirst = () => {};
      const firstBlocked = new Promise<void>(resolve => (releaseFirst = resolve));
      const calls: Array<{ model: string; ctx: ApplyContext }> = [];
      const stillCurrentAfterRelease: boolean[] = [];
      const { send, applyDefaultToRunningSessions } = await setup({
        withApply: true,
        apply: async (selection, ctx) => {
          calls.push({ model: selection.model, ctx });
          if (calls.length === 1) {
            await firstBlocked;
            stillCurrentAfterRelease.push(await ctx.stillCurrent!());
          }
          return { applied: [], skipped: [] };
        },
      });
      const completed = vi.spyOn(console, 'info').mockImplementation(() => {});
      try {
        await send('PUT', 'codex-stub', { model: 'gpt-5-mini' });
        expect((await send('POST', 'codex-stub', undefined, '/apply')).status).toBe(202);
        await vi.waitFor(() => expect(calls).toHaveLength(1));

        await send('PUT', 'codex-stub', { model: 'gpt-5.3-codex' });
        const second = await send('POST', 'codex-stub', undefined, '/apply');
        expect(second.status).toBe(202);
        expect(await second.json()).toEqual({
          selection: { instanceId: 'codex-stub', model: 'gpt-5.3-codex' },
          status: 'started',
        });
        // The second waits for the first.
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(applyDefaultToRunningSessions).toHaveBeenCalledTimes(1);

        releaseFirst();
        await vi.waitFor(() => expect(calls).toHaveLength(2));
        expect(calls.map(call => call.model)).toEqual(['gpt-5-mini', 'gpt-5.3-codex']);
        // The older job sees its default is no longer the Factory's.
        expect(stillCurrentAfterRelease).toEqual([false]);
        expect(await calls[1]!.ctx.stillCurrent!()).toBe(true);
      } finally {
        releaseFirst();
        completed.mockRestore();
      }
    });
  });

  it('keeps a Factory’s tool permissions for an organization admin and rejects unknown categories and policies', async () => {
    const seed = await createFactoryStorageForTests();
    const project = await seed.projects.create({
      orgId: 'org-1',
      userId: 'user-1',
      input: { name: 'Shared', harness: 'claude-code' },
    });
    expect(project.toolPermissions).toBeNull();
    const isOrganizationAdmin = vi.fn(async () => false);
    const app = new Hono();
    app.use('*', async (context, next) => {
      context.set('factoryAuthUser' as never, { id: 'member', organizationId: 'org-1' } as never);
      await next();
    });
    mountApiRoutes(
      app as never,
      projectRoutes(seed, undefined, undefined, undefined, { auth: fakeRouteAuth({ isOrganizationAdmin }) }),
    );
    const patch = (body: Record<string, unknown>) =>
      app.request(`/web/factory/projects/${project.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const permissions = { categories: { read: 'allow', execute: 'deny' }, yolo: false };

    const denied = await patch({ toolPermissions: permissions });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({
      message: 'Organization administrator access is required to change the tool permissions.',
    });
    expect((await seed.projects.getById({ id: project.id }))?.toolPermissions).toBeNull();

    isOrganizationAdmin.mockResolvedValue(true);
    expect((await patch({ toolPermissions: { categories: { sudo: 'allow' }, yolo: false } })).status).toBe(400);
    expect((await patch({ toolPermissions: { categories: { read: 'maybe' }, yolo: false } })).status).toBe(400);
    expect((await patch({ toolPermissions: { categories: {} } })).status).toBe(400);

    const saved = await patch({ toolPermissions: permissions });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ project: { toolPermissions: permissions } });
    expect((await seed.projects.getById({ id: project.id }))?.toolPermissions).toEqual(permissions);

    const cleared = await patch({ toolPermissions: null });
    expect(cleared.status).toBe(200);
    expect((await seed.projects.getById({ id: project.id }))?.toolPermissions).toBeNull();
  });

  it('creates a project without a model scope, ignoring one an old client sends', async () => {
    const seed = await createFactoryStorageForTests();
    const app = new Hono();
    app.use('*', async (context, next) => {
      context.set('factoryAuthUser' as never, { id: 'user-1', organizationId: 'org-1' } as never);
      await next();
    });
    mountApiRoutes(app as never, projectRoutes(seed));
    const create = (body: Record<string, unknown>) =>
      app.request('/web/factory/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    const created = await create({ name: 'Personal', modelScope: 'user' });
    expect(created.status).toBe(201);
    const { project } = (await created.json()) as { project: Record<string, unknown> & { id: string } };
    expect(project).not.toHaveProperty('modelScope');
    expect(await seed.projects.getById({ id: project.id })).not.toHaveProperty('modelScope');

    expect((await create({ name: 'Other', modelScope: 'org' })).status).toBe(201);
  });


  it('retires active repository sessions before destructive project deletion', async () => {
    const seed = await createFactoryStorageForTests();
    const project = await seed.projects.create({ orgId: 'org-1', userId: 'user-1', input: { name: 'Platform' } });
    const github = seed.sourceControl.forIntegration('github');
    const installation = await github.installations.upsert({
      orgId: 'org-1',
      connectedByUserId: 'user-1',
      externalId: 'gh-1',
    });
    const repository = await github.repositories.upsert({
      orgId: 'org-1',
      input: {
        installationId: installation.id,
        externalId: 'repo-1',
        slug: 'acme/api',
        defaultBranch: 'main',
      },
    });
    const connection = await github.connections.create({
      orgId: 'org-1',
      factoryProjectId: project.id,
      installationId: installation.id,
      createdByUserId: 'user-1',
    });
    const link = await github.projectRepositories.link({
      orgId: 'org-1',
      connectionId: connection.id,
      repositoryId: repository.id,
      createdByUserId: 'user-1',
      sandboxProvider: 'local',
      sandboxWorkdir: '/workspace/acme/api',
      teardownCommand: 'pnpm local teardown',
    });
    await github.sessions.create({
      sessionId: 'session-1',
      projectRepositoryId: link.id,
      orgId: 'org-1',
      userId: 'user-1',
      branch: 'feat/x',
      baseBranch: 'main',
    });
    const retireProjectRepositorySessions = vi.fn(async () => {
      expect(await github.sessions.listByProjectRepository({ projectRepositoryId: link.id })).toHaveLength(1);
    });
    const app = new Hono();
    app.use('*', async (context, next) => {
      context.set('factoryAuthUser' as never, { id: 'user-1', organizationId: 'org-1' } as never);
      await next();
    });
    mountApiRoutes(app as never, projectRoutes(seed, ['github'], { retireProjectRepositorySessions } as any));

    const response = await app.request(`/web/factory/projects/${project.id}`, { method: 'DELETE' });

    expect(response.status).toBe(204);
    expect(retireProjectRepositorySessions).toHaveBeenCalledOnce();
    expect(retireProjectRepositorySessions.mock.calls[0]?.[0]).toMatchObject({
      sourceControl: { integrationId: 'github' },
      orgId: 'org-1',
      projectRepositoryId: link.id,
    });
  });

  it('rejects destructive project deletion when materialized sessions cannot be retired', async () => {
    const seed = await createFactoryStorageForTests();
    const project = await seed.projects.create({ orgId: 'org-1', userId: 'user-1', input: { name: 'Platform' } });
    const github = seed.sourceControl.forIntegration('github');
    const installation = await github.installations.upsert({
      orgId: 'org-1',
      connectedByUserId: 'user-1',
      externalId: 'gh-1',
    });
    const repository = await github.repositories.upsert({
      orgId: 'org-1',
      input: {
        installationId: installation.id,
        externalId: 'repo-1',
        slug: 'acme/api',
        defaultBranch: 'main',
      },
    });
    const connection = await github.connections.create({
      orgId: 'org-1',
      factoryProjectId: project.id,
      installationId: installation.id,
      createdByUserId: 'user-1',
    });
    const link = await github.projectRepositories.link({
      orgId: 'org-1',
      connectionId: connection.id,
      repositoryId: repository.id,
      createdByUserId: 'user-1',
      sandboxProvider: 'local',
      sandboxWorkdir: '/workspace/acme/api',
      teardownCommand: 'pnpm local teardown',
    });
    const session = await github.sessions.create({
      sessionId: 'session-1',
      projectRepositoryId: link.id,
      orgId: 'org-1',
      userId: 'user-1',
      branch: 'feat/x',
      baseBranch: 'main',
    });
    await github.sessions.setSandbox({
      id: session.id,
      sandboxId: 'sandbox-1',
      sandboxWorkdir: '/workspace/acme/api/session-1',
    });
    const app = new Hono();
    app.use('*', async (context, next) => {
      context.set('factoryAuthUser' as never, { id: 'user-1', organizationId: 'org-1' } as never);
      await next();
    });
    mountApiRoutes(app as never, projectRoutes(seed, ['github']));

    const response = await app.request(`/web/factory/projects/${project.id}`, { method: 'DELETE' });

    expect(response.status).toBe(409);
    expect(await seed.projects.get({ orgId: 'org-1', id: project.id })).not.toBeNull();
    expect(await github.sessions.getBySessionId('session-1')).not.toBeNull();
  });

  it('links installations and repositories from multiple source-control providers', async () => {
    const seed = await createFactoryStorageForTests();
    const project = await seed.projects.create({ orgId: 'org-1', userId: 'user-1', input: { name: 'Platform' } });
    const github = seed.sourceControl.forIntegration('github');
    const gitlab = seed.sourceControl.forIntegration('gitlab');
    const githubInstallation = await github.installations.upsert({
      orgId: 'org-1',
      connectedByUserId: 'user-1',
      externalId: 'gh-1',
      accountName: 'acme',
    });
    const gitlabInstallation = await gitlab.installations.upsert({
      orgId: 'org-1',
      connectedByUserId: 'user-1',
      externalId: 'gl-1',
      accountName: 'acme-group',
    });
    const resolveRepository = vi.fn(
      async ({
        orgId,
        installationId,
        externalId,
        slug,
      }: Parameters<NonNullable<ConstructorParameters<typeof ProjectRoutes>[0]['resolveRepository']>>[0]) =>
        github.repositories.upsert({
          orgId,
          input: { installationId, externalId, slug, defaultBranch: 'main' },
        }),
    );
    const gitlabRepository = await gitlab.repositories.upsert({
      orgId: 'org-1',
      input: {
        installationId: gitlabInstallation.id,
        externalId: 'repo-2',
        slug: 'acme/web',
        defaultBranch: 'trunk',
      },
    });
    const app = new Hono();
    app.use('*', async (context, next) => {
      context.set('factoryAuthUser' as never, { id: 'user-1', organizationId: 'org-1' } as never);
      await next();
    });
    mountApiRoutes(app as never, projectRoutes(seed, ['github', 'gitlab'], undefined, resolveRepository));

    const connect = async (integrationId: string, installationId: string) => {
      const response = await app.request(`/web/factory/projects/${project.id}/source-control-connections`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ integrationId, installationId }),
      });
      expect(response.status).toBe(201);
      return ((await response.json()) as { connection: { id: string } }).connection;
    };
    const githubConnection = await connect('github', githubInstallation.id);
    const gitlabConnection = await connect('gitlab', gitlabInstallation.id);

    const link = async (connectionId: string, repositoryId: string, branch: string) => {
      const response = await app.request(
        `/web/factory/projects/${project.id}/source-control-connections/${connectionId}/repositories`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            repositoryId,
            branch,
            sandboxProvider: 'local',
            sandboxWorkdir: `/workspace/${repositoryId}`,
            setupCommand: 'pnpm install',
            teardownCommand: 'pnpm local worktree teardown',
          }),
        },
      );
      expect(response.status).toBe(201);
      return ((await response.json()) as { projectRepository: { id: string } }).projectRepository;
    };
    const githubLinkResponse = await app.request(
      `/web/factory/projects/${project.id}/source-control-connections/${githubConnection.id}/repositories`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          repository: { externalId: 'repo-1', slug: 'acme/api' },
          branch: 'release',
          sandboxProvider: 'local',
          sandboxWorkdir: '/workspace/api',
          setupCommand: 'pnpm install',
          teardownCommand: 'pnpm local worktree teardown',
        }),
      },
    );
    expect(githubLinkResponse.status).toBe(201);
    const githubLink = ((await githubLinkResponse.json()) as { projectRepository: { id: string } }).projectRepository;
    expect(resolveRepository).toHaveBeenCalledWith({
      integrationId: 'github',
      orgId: 'org-1',
      userId: 'user-1',
      installationId: githubInstallation.id,
      externalId: 'repo-1',
      slug: 'acme/api',
    });
    await link(gitlabConnection.id, gitlabRepository.id, 'trunk');

    const listResponse = await app.request(`/web/factory/projects/${project.id}/source-control-connections`);
    expect(listResponse.status).toBe(200);
    const listed = (await listResponse.json()) as {
      connections: Array<{ integrationId: string; repositories: Array<{ repository: { slug: string } }> }>;
    };
    expect(listed.connections.map(connection => connection.integrationId).sort()).toEqual(['github', 'gitlab']);
    expect(
      listed.connections.flatMap(connection => connection.repositories.map(link => link.repository.slug)).sort(),
    ).toEqual(['acme/api', 'acme/web']);

    const updateResponse = await app.request(`/web/factory/projects/${project.id}/repositories/${githubLink.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ branch: 'stable', setupCommand: null, teardownCommand: 'docker compose down' }),
    });
    expect(updateResponse.status).toBe(200);
    expect((await updateResponse.json()) as unknown).toMatchObject({
      projectRepository: {
        branch: 'stable',
        setupCommand: null,
        teardownCommand: 'docker compose down',
        repository: { slug: 'acme/api' },
      },
    });
  });

  it('rejects cross-organization and cross-installation project links', async () => {
    const seed = await createFactoryStorageForTests();
    const project = await seed.projects.create({ orgId: 'org-1', userId: 'user-1', input: { name: 'Platform' } });
    const github = seed.sourceControl.forIntegration('github');
    const installation = await github.installations.upsert({
      orgId: 'org-1',
      connectedByUserId: 'user-1',
      externalId: 'gh-1',
    });
    const otherInstallation = await github.installations.upsert({
      orgId: 'org-1',
      connectedByUserId: 'user-1',
      externalId: 'gh-2',
    });
    const otherOrgInstallation = await github.installations.upsert({
      orgId: 'org-2',
      connectedByUserId: 'user-2',
      externalId: 'gh-3',
    });
    const repository = await github.repositories.upsert({
      orgId: 'org-1',
      input: {
        installationId: otherInstallation.id,
        externalId: 'repo-1',
        slug: 'acme/other',
        defaultBranch: 'main',
      },
    });
    const app = new Hono();
    app.use('*', async (context, next) => {
      context.set('factoryAuthUser' as never, { id: 'user-1', organizationId: 'org-1' } as never);
      await next();
    });
    mountApiRoutes(app as never, projectRoutes(seed, ['github']));

    expect(
      (
        await app.request(`/web/factory/projects/${project.id}/source-control-connections`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ integrationId: 'github', installationId: otherOrgInstallation.id }),
        })
      ).status,
    ).toBe(404);

    const connection = await github.connections.create({
      orgId: 'org-1',
      factoryProjectId: project.id,
      installationId: installation.id,
      createdByUserId: 'user-1',
    });
    expect(
      (
        await app.request(
          `/web/factory/projects/${project.id}/source-control-connections/${connection.id}/repositories`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              repositoryId: repository.id,
              sandboxProvider: 'local',
              sandboxWorkdir: '/workspace/repo',
            }),
          },
        )
      ).status,
    ).toBe(404);
  });

  // Repro for "stuck on page loader after uninstalling + reinstalling the
  // GitHub App": when GitHub returns 404 for a known installation the factory
  // prunes the installation row (see integrations/github/routes.ts) but the
  // connection + project_repository rows are left behind pointing at the now-
  // deleted installation id. Reinstalling in GitHub does NOT resurrect that
  // installation id, so the stale connection is orphaned forever.
  //
  // The web UI hydrates every project via
  //   GET /web/factory/projects/:id/source-control-connections
  // through useFactoriesQuery. If that endpoint 500s for a single project the
  // whole query rejects and the app never leaves its page loader.
  //
  // Today, that GET throws:
  //   Error: Project source-control connection not found for this
  //   organization and integration.
  // because projects.ts iterates connections.list (which does not filter by
  // installation existence) and then calls projectRepositories.list, which
  // calls requireConnection, which throws when the installation is gone.
  it.each([
    ['notifies the repository-linked hook', () => undefined],
    [
      'still links when the repository-linked hook throws',
      () => {
        throw new Error('backlog import unavailable');
      },
    ],
  ])('%s', async (_name, behavior) => {
    const seed = await createFactoryStorageForTests();
    const project = await seed.projects.create({ orgId: 'org-1', userId: 'user-1', input: { name: 'Platform' } });
    const github = seed.sourceControl.forIntegration('github');
    const installation = await github.installations.upsert({
      orgId: 'org-1',
      connectedByUserId: 'user-1',
      externalId: 'gh-1',
      accountName: 'acme',
    });
    const repository = await github.repositories.upsert({
      orgId: 'org-1',
      input: { installationId: installation.id, externalId: 'repo-1', slug: 'acme/api', defaultBranch: 'main' },
    });
    const onProjectRepositoryLinked = vi.fn(behavior);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const app = new Hono();
    app.use('*', async (context, next) => {
      context.set('factoryAuthUser' as never, { id: 'user-1', organizationId: 'org-1' } as never);
      await next();
    });
    mountApiRoutes(app as never, projectRoutes(seed, ['github'], undefined, undefined, { onProjectRepositoryLinked }));
    const connectResponse = await app.request(`/web/factory/projects/${project.id}/source-control-connections`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ integrationId: 'github', installationId: installation.id }),
    });
    const { connection } = (await connectResponse.json()) as { connection: { id: string } };

    const linkResponse = await app.request(
      `/web/factory/projects/${project.id}/source-control-connections/${connection.id}/repositories`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          repositoryId: repository.id,
          branch: 'main',
          sandboxProvider: 'local',
          sandboxWorkdir: '/workspace/acme/api',
        }),
      },
    );

    expect(linkResponse.status).toBe(201);
    expect(onProjectRepositoryLinked).toHaveBeenCalledWith({
      orgId: 'org-1',
      projectRepository: expect.objectContaining({ repositoryId: repository.id, connectionId: connection.id }),
    });
    warn.mockRestore();
  });

  it('does not 500 when a linked GitHub installation was pruned (uninstalled)', async () => {
    const seed = await createFactoryStorageForTests();
    const project = await seed.projects.create({ orgId: 'org-1', userId: 'user-1', input: { name: 'Platform' } });
    const github = seed.sourceControl.forIntegration('github');
    const installation = await github.installations.upsert({
      orgId: 'org-1',
      connectedByUserId: 'user-1',
      externalId: 'gh-1',
      accountName: 'acme',
    });
    const repository = await github.repositories.upsert({
      orgId: 'org-1',
      input: {
        installationId: installation.id,
        externalId: 'repo-1',
        slug: 'acme/api',
        defaultBranch: 'main',
      },
    });

    const app = new Hono();
    app.use('*', async (context, next) => {
      context.set('factoryAuthUser' as never, { id: 'user-1', organizationId: 'org-1' } as never);
      await next();
    });
    mountApiRoutes(app as never, projectRoutes(seed, ['github']));

    const connectResponse = await app.request(`/web/factory/projects/${project.id}/source-control-connections`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ integrationId: 'github', installationId: installation.id }),
    });
    expect(connectResponse.status).toBe(201);
    const { connection } = (await connectResponse.json()) as { connection: { id: string } };

    const linkResponse = await app.request(
      `/web/factory/projects/${project.id}/source-control-connections/${connection.id}/repositories`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          repositoryId: repository.id,
          branch: 'main',
          sandboxProvider: 'local',
          sandboxWorkdir: '/workspace/acme/api',
        }),
      },
    );
    expect(linkResponse.status).toBe(201);

    // Sanity: hydration works before the app is uninstalled.
    const healthy = await app.request(`/web/factory/projects/${project.id}/source-control-connections`);
    expect(healthy.status).toBe(200);

    // Simulate the pruning that happens in integrations/github/routes.ts when
    // GitHub returns 404 for the installation (i.e. the user uninstalled the
    // GitHub App from their org/account).
    await github.installations.delete({ orgId: 'org-1', id: installation.id });

    // This is the request the web UI fires on every page load. It must not
    // 500, or useFactoriesQuery rejects and the page hangs on the loader.
    const stale = await app.request(`/web/factory/projects/${project.id}/source-control-connections`);
    expect(stale.status).toBe(200);
    const staleBody = (await stale.json()) as { connections: Array<{ id: string }> };
    // Orphaned connection is either omitted or returned in a
    // needs-reconnect shape — either is fine, but the request MUST succeed.
    expect(Array.isArray(staleBody.connections)).toBe(true);

    const list = await app.request('/web/factory/projects');
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({ projects: [{ id: project.id, repositories: [] }] });
  });

  describe('repositories in the project list', () => {
    async function factoriesWithRepositories(factoryCount: number) {
      const seed = await createFactoryStorageForTests();
      const github = seed.sourceControl.forIntegration('github');
      const gitlab = seed.sourceControl.forIntegration('gitlab');
      const githubInstallation = await github.installations.upsert({
        orgId: 'org-1',
        connectedByUserId: 'user-1',
        externalId: 'gh-1',
      });
      const gitlabInstallation = await gitlab.installations.upsert({
        orgId: 'org-1',
        connectedByUserId: 'user-1',
        externalId: 'gl-1',
      });
      const factories = [];
      for (let index = 0; index < factoryCount; index++) {
        const project = await seed.projects.create({
          orgId: 'org-1',
          userId: 'user-1',
          input: { name: `Factory ${index}` },
        });
        const links = [];
        for (const [handle, installationId, slug, branch] of [
          [github, githubInstallation.id, `acme/api-${index}`, 'release'],
          [gitlab, gitlabInstallation.id, `acme/web-${index}`, null],
        ] as const) {
          const connection = await handle.connections.create({
            orgId: 'org-1',
            factoryProjectId: project.id,
            installationId,
            createdByUserId: 'user-1',
          });
          const repository = await handle.repositories.upsert({
            orgId: 'org-1',
            input: { installationId, externalId: `${slug}-id`, slug, defaultBranch: 'main' },
          });
          const link = await handle.projectRepositories.link({
            orgId: 'org-1',
            connectionId: connection.id,
            repositoryId: repository.id,
            createdByUserId: 'user-1',
            branch,
            sandboxProvider: 'local',
            sandboxWorkdir: `/workspace/${slug}`,
          });
          links.push({ connection, repository, link });
        }
        factories.push({ project, links });
      }
      const app = new Hono();
      app.use('*', async (context, next) => {
        context.set('factoryAuthUser' as never, { workosId: 'user-1', organizationId: 'org-1' } as never);
        await next();
      });
      mountApiRoutes(app as never, projectRoutes(seed, ['github', 'gitlab']));
      return { seed, app, factories };
    }

    it('lists each factory with its linked repositories and nothing about the installations', async () => {
      const { seed, app, factories } = await factoriesWithRepositories(1);
      const [{ project, links }] = factories;
      const empty = await seed.projects.create({ orgId: 'org-1', userId: 'user-1', input: { name: 'Empty' } });
      const otherOrgGithub = seed.sourceControl.forIntegration('github');
      const otherOrgInstallation = await otherOrgGithub.installations.upsert({
        orgId: 'org-2',
        connectedByUserId: 'user-2',
        externalId: 'gh-2',
      });
      const otherOrgProject = await seed.projects.create({
        orgId: 'org-2',
        userId: 'user-2',
        input: { name: 'Other' },
      });
      const otherOrgConnection = await otherOrgGithub.connections.create({
        orgId: 'org-2',
        factoryProjectId: otherOrgProject.id,
        installationId: otherOrgInstallation.id,
        createdByUserId: 'user-2',
      });
      const otherOrgRepository = await otherOrgGithub.repositories.upsert({
        orgId: 'org-2',
        input: {
          installationId: otherOrgInstallation.id,
          externalId: 'secret',
          slug: 'rival/secret',
          defaultBranch: 'main',
        },
      });
      await otherOrgGithub.projectRepositories.link({
        orgId: 'org-2',
        connectionId: otherOrgConnection.id,
        repositoryId: otherOrgRepository.id,
        createdByUserId: 'user-2',
        sandboxProvider: 'local',
        sandboxWorkdir: '/workspace/secret',
      });

      const response = await app.request('/web/factory/projects');
      expect(response.status).toBe(200);
      const body = (await response.json()) as { projects: Array<{ id: string; repositories: unknown[] }> };
      expect(FACTORY_ROUTE_CONTRACTS.projectList.responseSchema.safeParse(body).success).toBe(true);
      expect(body.projects.map(({ id }) => id).sort()).toEqual([project.id, empty.id].sort());
      const [githubLink, gitlabLink] = links;
      expect(body.projects.find(({ id }) => id === project.id)?.repositories).toEqual([
        {
          projectRepositoryId: githubLink!.link.id,
          connectionId: githubLink!.connection.id,
          integrationId: 'github',
          repositoryId: githubLink!.repository.id,
          externalId: 'acme/api-0-id',
          slug: 'acme/api-0',
          defaultBranch: 'main',
          branch: 'release',
          sandboxWorkdir: '/workspace/acme/api-0',
          position: githubLink!.link.position,
          inEnvironment: true,
        },
        {
          projectRepositoryId: gitlabLink!.link.id,
          connectionId: gitlabLink!.connection.id,
          integrationId: 'gitlab',
          repositoryId: gitlabLink!.repository.id,
          externalId: 'acme/web-0-id',
          slug: 'acme/web-0',
          defaultBranch: 'main',
          branch: null,
          sandboxWorkdir: '/workspace/acme/web-0',
          position: gitlabLink!.link.position,
          inEnvironment: true,
        },
      ]);
      expect(body.projects.find(({ id }) => id === empty.id)?.repositories).toEqual([]);
      expect(JSON.stringify(body)).not.toContain('rival/secret');

      const connections = (await (
        await app.request(`/web/factory/projects/${project.id}/source-control-connections`)
      ).json()) as {
        connections: Array<{
          integrationId: string;
          installation: { externalId: string };
          repositories: Array<{ id: string; repository: { slug: string } | null }>;
        }>;
      };
      expect(
        connections.connections.map(connection => ({
          integrationId: connection.integrationId,
          installation: connection.installation.externalId,
          links: connection.repositories.map(link => [link.id, link.repository?.slug]),
        })),
      ).toEqual([
        { integrationId: 'github', installation: 'gh-1', links: [[githubLink!.link.id, 'acme/api-0']] },
        { integrationId: 'gitlab', installation: 'gl-1', links: [[gitlabLink!.link.id, 'acme/web-0']] },
      ]);
    });

    it('reads the same number of queries for one factory as for many', async () => {
      const queriesForProjectList = async (factoryCount: number) => {
        const { seed, app } = await factoriesWithRepositories(factoryCount);
        const findMany = vi.spyOn(seed.storage.ops, 'findMany');
        const findOne = vi.spyOn(seed.storage.ops, 'findOne');
        const response = await app.request('/web/factory/projects');
        expect(response.status).toBe(200);
        const body = (await response.json()) as { projects: Array<{ repositories: unknown[] }> };
        expect(body.projects).toHaveLength(factoryCount);
        expect(body.projects.every(({ repositories }) => repositories.length === 2)).toBe(true);
        return findMany.mock.calls.length + findOne.mock.calls.length;
      };

      const one = await queriesForProjectList(1);
      expect(await queriesForProjectList(5)).toBe(one);
    });
  });

  it('rejects invalid create and update payloads', async () => {
    const seed = await createFactoryStorageForTests();
    const app = new Hono();
    app.use('*', async (context, next) => {
      context.set('factoryAuthUser' as never, { id: 'user-1', organizationId: 'org-1' } as never);
      await next();
    });
    mountApiRoutes(app as never, projectRoutes(seed));

    expect(
      (
        await app.request('/web/factory/projects', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: '   ' }),
        })
      ).status,
    ).toBe(400);
    const malformed = await app.request('/web/factory/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: 'invalid_project' });
    expect((await app.request('/web/factory/projects/not-a-uuid')).status).toBe(404);

    const project = await seed.projects.create({ orgId: 'org-1', userId: 'user-1', input: { name: 'Valid' } });
    expect(
      (
        await app.request(`/web/factory/projects/${project.id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        })
      ).status,
    ).toBe(400);

    const invalidScope = await app.request(`/web/factory/projects/${project.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modelScope: 'org' }),
    });
    expect(invalidScope.status).toBe(400);
    expect(await invalidScope.json()).toEqual({ error: 'invalid_project' });
  });

  describe('environment', () => {
    /** A provider with two integer settings, strict about unknown keys. */
    class StubFactorySandbox extends FactorySandbox<{ cpuCount?: number; memoryMb?: number }> {
      readonly provider = 'stub';
      readonly settings = {
        type: 'object',
        properties: {
          // A schema default is advertised to the UI and never written by factory (D8).
          cpuCount: { type: 'integer', minimum: 1, maximum: 64, default: 2 },
          memoryMb: { type: 'integer', minimum: 512 },
        },
        additionalProperties: false,
      } as const;
      create(_ctx: FactorySandboxContext) {
        throw new Error('not constructed in route tests');
      }
    }

    async function seedEnvironment() {
      const seed = await createFactoryStorageForTests();
      const project = await seed.projects.create({ orgId: 'org-1', userId: 'user-1', input: { name: 'Env' } });
      const github = seed.sourceControl.forIntegration('github');
      const installation = await github.installations.upsert({
        orgId: 'org-1',
        connectedByUserId: 'user-1',
        externalId: 'gh-1',
        accountName: 'acme',
      });
      const connection = await github.connections.create({
        orgId: 'org-1',
        factoryProjectId: project.id,
        installationId: installation.id,
        createdByUserId: 'user-1',
      });
      const links = [];
      for (const slug of ['acme/docs', 'acme/api', 'acme/web']) {
        const repository = await github.repositories.upsert({
          orgId: 'org-1',
          input: { installationId: installation.id, externalId: slug, slug, defaultBranch: 'main' },
        });
        links.push(
          await github.projectRepositories.link({
            orgId: 'org-1',
            connectionId: connection.id,
            repositoryId: repository.id,
            createdByUserId: 'user-1',
            branch: 'main',
            sandboxProvider: 'local',
            sandboxWorkdir: '/workspace',
            setupCommand: 'pnpm i',
          }),
        );
      }
      const app = new Hono();
      app.use('*', async (context, next) => {
        context.set('factoryAuthUser' as never, { id: 'user-1', organizationId: 'org-1' } as never);
        await next();
      });
      mountApiRoutes(
        app as never,
        projectRoutes(seed, ['github'], undefined, undefined, { sandbox: new StubFactorySandbox() }),
      );
      return { seed, project, github, links, app };
    }

    const patch = (app: Hono, projectId: string, body: unknown) =>
      app.request(`/web/factory/projects/${projectId}/environment`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    it.each([null, '/custom-workspace'])(
      'preserves the project workdir %s across source-control initialization',
      async workdir => {
        const { seed, project, app, github, links } = await seedEnvironment();
        expect((await patch(app, project.id, { sandboxWorkingDirectory: '/initial-workspace' })).status).toBe(200);
        expect((await patch(app, project.id, { sandboxWorkingDirectory: workdir })).status).toBe(200);

        for (let attempt = 0; attempt < 2; attempt += 1) {
          await seed.sourceControl.init();
          const response = await app.request(`/web/factory/projects/${project.id}/environment`);
          expect(response.status).toBe(200);
          expect(await response.json()).toMatchObject({ environment: { sandboxWorkingDirectory: workdir } });
          expect(await seed.projects.getById({ id: project.id })).toMatchObject({ sandboxWorkingDirectory: workdir });
        }
        expect(await github.projectRepositories.get({ orgId: 'org-1', id: links[0]!.id })).toMatchObject({
          sandboxWorkdir: '/workspace',
        });
      },
    );

    it('reads the provider schema and empty settings with the ordered repositories, and writes settings, order and membership', async () => {
      const { seed, project, links, app, github } = await seedEnvironment();

      const read = await app.request(`/web/factory/projects/${project.id}/environment`);
      expect(read.status).toBe(200);
      const initial = (await read.json()) as { environment: Record<string, unknown> };
      expect(initial.environment).toMatchObject({
        sandbox: {
          provider: 'stub',
          settingsSchema: { type: 'object', additionalProperties: false },
          capabilities: { template: false, builds: { available: false, history: false } },
        },
        settings: {},
        sandboxWorkingDirectory: null,
        workspaceSetupCommand: null,
        activeTemplateId: null,
        activeTemplateHeads: null,
      });
      expect(
        Object.keys(
          (initial.environment.sandbox as { settingsSchema: { properties: object } }).settingsSchema.properties,
        ),
      ).toEqual(['cpuCount', 'memoryMb']);
      // An unset setting is absent from the stored document; nothing is written on read.
      expect(await seed.projects.getById({ id: project.id })).toMatchObject({ sandboxSettings: null });
      expect(
        (initial.environment.repositories as Array<Record<string, unknown>>).map(r => [
          r.slug,
          r.position,
          r.inEnvironment,
          r.lastBuildStatus,
        ]),
      ).toEqual([
        ['acme/docs', 1, true, 'unbuilt'],
        ['acme/api', 2, true, 'unbuilt'],
        ['acme/web', 3, true, 'unbuilt'],
      ]);

      const updated = await patch(app, project.id, {
        sandboxWorkingDirectory: '/home/user',
        settings: { cpuCount: 8 },
        workspaceSetupCommand: 'pnpm -r build',
        repositories: [
          { projectRepositoryId: links[2]!.id, position: 1 },
          { projectRepositoryId: links[0]!.id, position: 2, inEnvironment: false, setupCommand: null },
          { projectRepositoryId: links[1]!.id, position: 3, teardownCommand: 'docker compose down' },
        ],
      });
      expect(updated.status).toBe(200);
      const after = (await updated.json()) as { environment: Record<string, unknown> };
      expect(after.environment).toMatchObject({
        sandboxWorkingDirectory: '/home/user',
        settings: { cpuCount: 8 },
        workspaceSetupCommand: 'pnpm -r build',
      });
      expect(await seed.projects.getById({ id: project.id })).toMatchObject({ sandboxSettings: { cpuCount: 8 } });
      expect(
        (after.environment.repositories as Array<Record<string, unknown>>).map(r => [
          r.slug,
          r.position,
          r.inEnvironment,
          r.setupCommand,
          r.teardownCommand,
        ]),
      ).toEqual([
        ['acme/web', 1, true, 'pnpm i', null],
        ['acme/docs', 2, false, null, null],
        ['acme/api', 3, true, 'pnpm i', 'docker compose down'],
      ]);
      // Existing per-link fields are untouched by the environment route.
      const stored = await github.projectRepositories.get({ orgId: 'org-1', id: links[0]!.id });
      expect(stored).toMatchObject({ branch: 'main', sandboxProvider: 'local', sandboxWorkdir: '/workspace' });

      // Re-reading returns the same shape the PATCH returned.
      const reread = (await (await app.request(`/web/factory/projects/${project.id}/environment`)).json()) as unknown;
      expect(reread).toEqual(after);

      // Build-status fields in the body are ignored, not written.
      const mixed = await patch(app, project.id, {
        settings: { memoryMb: 1024 },
        repositories: [{ projectRepositoryId: links[1]!.id, inEnvironment: false, lastBuildStatus: 'failed' }],
      });
      expect(mixed.status).toBe(200);
      expect(await github.projectRepositories.get({ orgId: 'org-1', id: links[1]!.id })).toMatchObject({
        inEnvironment: false,
        lastBuildStatus: 'unbuilt',
      });

      // The patch merged onto the stored document.
      expect(await seed.projects.getById({ id: project.id })).toMatchObject({
        sandboxSettings: { cpuCount: 8, memoryMb: 1024 },
      });

      // A key the user never set is absent even though the schema declares a default for it.
      await patch(app, project.id, { settings: { cpuCount: null } });
      expect((await seed.projects.getById({ id: project.id }))?.sandboxSettings).toEqual({ memoryMb: 1024 });
      await patch(app, project.id, { settings: { cpuCount: 8 } });

      // null removes a key and hands it back to the provider default; an empty document is stored as null.
      const cleared = await patch(app, project.id, { settings: { cpuCount: null } });
      expect(cleared.status).toBe(200);
      expect(((await cleared.json()) as { environment: Record<string, unknown> }).environment).toMatchObject({
        settings: { memoryMb: 1024 },
      });
      await patch(app, project.id, { settings: { memoryMb: null } });
      expect(await seed.projects.getById({ id: project.id })).toMatchObject({ sandboxSettings: null });
      expect(
        (
          (await (await app.request(`/web/factory/projects/${project.id}/environment`)).json()) as {
            environment: Record<string, unknown>;
          }
        ).environment.settings,
      ).toEqual({});
    });

    it('rejects settings the provider schema refuses, naming the field', async () => {
      const { project, app, seed } = await seedEnvironment();
      await patch(app, project.id, { settings: { cpuCount: 4 } });

      for (const [settings, field] of [
        [{ cpuCount: 'two' }, 'cpuCount'],
        [{ cpuCount: 65 }, 'cpuCount'],
        [{ memoryMb: 256 }, 'memoryMb'],
        // Ajv reports the extra key in its message, not the path.
        [{ unknown: 1 }, 'additional properties'],
      ] as const) {
        const response = await patch(app, project.id, { settings });
        expect(response.status, JSON.stringify(settings)).toBe(400);
        const body = (await response.json()) as { error: string; issues: Array<{ message: string; path: unknown[] }> };
        expect(body.error).toBe('invalid_environment');
        expect(JSON.stringify(body.issues)).toContain(field);
      }
      // A rejected merge leaves the stored document untouched.
      expect(await seed.projects.getById({ id: project.id })).toMatchObject({ sandboxSettings: { cpuCount: 4 } });
    });

    it('drops stored keys the current provider does not declare instead of refusing every later update', async () => {
      const { seed, project, app } = await seedEnvironment();
      await patch(app, project.id, { settings: { cpuCount: 4, memoryMb: 1024 } });

      // The host restarts on a provider with a different schema; the E2B-style document is still stored.
      class ImageFactorySandbox extends FactorySandbox<{ baseImage?: string }> {
        readonly provider = 'image';
        readonly settings = {
          type: 'object',
          properties: { baseImage: { type: 'string' } },
          additionalProperties: false,
        } as const;
        create(_ctx: FactorySandboxContext) {
          throw new Error('not constructed in route tests');
        }
      }
      const switched = new Hono();
      switched.use('*', async (context, next) => {
        context.set('factoryAuthUser' as never, { id: 'user-1', organizationId: 'org-1' } as never);
        await next();
      });
      mountApiRoutes(
        switched as never,
        projectRoutes(seed, ['github'], undefined, undefined, { sandbox: new ImageFactorySandbox() }),
      );

      // The stale keys are pruned the first time they make the merge fail; the new value lands.
      const response = await patch(switched, project.id, { settings: { baseImage: 'node:22' } });
      expect(response.status).toBe(200);
      expect(await seed.projects.getById({ id: project.id })).toMatchObject({
        sandboxSettings: { baseImage: 'node:22' },
      });

      // A key the patch itself sets is never pruned: an unknown key in the patch is still refused.
      const refused = await patch(switched, project.id, { settings: { cpuCount: 2 } });
      expect(refused.status).toBe(400);
      expect(await refused.json()).toMatchObject({ error: 'invalid_environment' });
      expect(await seed.projects.getById({ id: project.id })).toMatchObject({
        sandboxSettings: { baseImage: 'node:22' },
      });

      // A patch that is itself invalid reports its own issues, not the pruning.
      const invalid = await patch(switched, project.id, { settings: { baseImage: 7 } });
      expect(invalid.status).toBe(400);
      expect(JSON.stringify(await invalid.json())).toContain('baseImage');
    });

    it('drops a stored value the schema now rejects instead of refusing every later update', async () => {
      const { seed, project, app } = await seedEnvironment();
      // Stored under an older, looser schema: below the current 512 minimum.
      await seed.projects.update({
        orgId: 'org-1',
        id: project.id,
        input: { sandboxSettings: { cpuCount: 4, memoryMb: 256 } },
      });

      const response = await patch(app, project.id, { settings: { cpuCount: 8 } });
      expect(response.status).toBe(200);
      expect((await seed.projects.getById({ id: project.id }))?.sandboxSettings).toEqual({ cpuCount: 8 });

      // A patch that sets the rejected value itself is still refused.
      const refused = await patch(app, project.id, { settings: { memoryMb: 256 } });
      expect(refused.status).toBe(400);
    });

    it('reports no sandbox and refuses settings when the factory has none configured', async () => {
      const seed = await createFactoryStorageForTests();
      const project = await seed.projects.create({ orgId: 'org-1', userId: 'user-1', input: { name: 'Env' } });
      const app = new Hono();
      app.use('*', async (context, next) => {
        context.set('factoryAuthUser' as never, { id: 'user-1', organizationId: 'org-1' } as never);
        await next();
      });
      mountApiRoutes(app as never, projectRoutes(seed));

      const read = (await (await app.request(`/web/factory/projects/${project.id}/environment`)).json()) as {
        environment: { sandbox: { provider: string }; settings: object };
      };
      expect(read.environment.sandbox).toEqual({
        provider: 'none',
        settingsSchema: { type: 'object', properties: {}, additionalProperties: false },
        capabilities: { template: false, builds: { available: false, history: false } },
      });
      expect(read.environment.settings).toEqual({});

      const refused = await patch(app, project.id, { settings: { cpuCount: 2 } });
      expect(refused.status).toBe(400);
      expect(await refused.json()).toEqual({ error: 'no_sandbox' });
      expect((await patch(app, project.id, { sandboxWorkingDirectory: '/home/user' })).status).toBe(200);
    });

    it('rejects invalid payloads without writing anything', async () => {
      const { project, links, app } = await seedEnvironment();
      const before = (await (await app.request(`/web/factory/projects/${project.id}/environment`)).json()) as unknown;

      const cases: unknown[] = [
        {},
        { settings: 'cpu' },
        { settings: { cpuCount: 'two' } },
        { sandboxWorkingDirectory: 'relative/path' },
        { repositories: [{ projectRepositoryId: links[0]!.id, position: 2 }] },
        // A reorder that lists only some of the project's links.
        {
          repositories: [
            { projectRepositoryId: links[0]!.id, position: 1 },
            { projectRepositoryId: links[1]!.id, position: 2 },
          ],
        },
        {
          repositories: [
            { projectRepositoryId: links[0]!.id, position: 1 },
            { projectRepositoryId: links[1]!.id, position: 1 },
          ],
        },
        {
          repositories: [
            { projectRepositoryId: links[0]!.id, position: 1 },
            { projectRepositoryId: links[0]!.id, position: 2 },
          ],
        },
        {
          repositories: [{ projectRepositoryId: links[0]!.id, position: 1 }, { projectRepositoryId: links[1]!.id }],
        },
      ];
      for (const body of cases) {
        const response = await patch(app, project.id, body);
        expect(response.status, JSON.stringify(body)).toBe(400);
        expect(await response.json()).toMatchObject({ error: 'invalid_environment' });
      }

      const foreign = await patch(app, project.id, {
        settings: { cpuCount: 2 },
        repositories: [{ projectRepositoryId: '00000000-0000-4000-8000-000000000000', inEnvironment: false }],
      });
      expect(foreign.status).toBe(404);

      const after = (await (await app.request(`/web/factory/projects/${project.id}/environment`)).json()) as unknown;
      expect(after).toEqual(before);
    });

    describe('builds', () => {
      const SHA = 'f'.repeat(40);
      // widened from a v3 module mock: real package exports, then the original overrides
vi.mock('@factory/integration-github', async importOriginal => ({
  ...(await importOriginal<typeof import('@factory/integration-github')>()),
  ...(await (() => ({ getBranchHead: vi.fn(async () => 'f'.repeat(40)) }))()),
}));

      type Settings = Record<string, unknown>;
      class BuildingSandbox extends FactorySandbox<Settings> {
        readonly provider = 'building';
        readonly settings = {
          type: 'object',
          properties: { cpuCount: { type: 'integer', minimum: 1 } },
          additionalProperties: false,
        } as const;
        readonly starts: Array<{ sessionId: string; settings: Settings }> = [];
        readonly reads: Array<{ buildId: string; heads: Record<string, string | undefined> }> = [];
        withHistory = false;
        /** Extra provider output, as a user's setup command might print it. */
        printed = '';
        readonly builds: FactorySandboxBuilds<Settings> = {
          start: async (ctx, settings) => {
            this.starts.push({ sessionId: ctx.sessionId, settings });
            return { buildId: 'tpl-1:build-1', status: 'building', templateId: 'tpl-1' };
          },
          get: async (ctx, _settings, buildId) => {
            this.reads.push({
              buildId,
              heads: { api: await ctx.resolveHead!('https://github.com/acme/api.git') },
            });
            return this.printed
              ? { buildId, status: 'failed', error: `setup failed: ${this.printed}`, logs: [this.printed] }
              : { buildId, status: 'ready', templateId: 'tpl-1' };
          },
          list: async () =>
            this.withHistory
              ? [
                  { buildId: 'tpl-1:build-1', status: 'ready' as const, templateId: 'tpl-1' },
                  {
                    buildId: 'tpl-1:build-0',
                    status: 'failed' as const,
                    error: 'clone https://x-access-token:ghs_secret@github.com/acme/api.git failed',
                    logs: ['git clone https://x-access-token:ghs_secret@github.com/acme/api.git', 'fatal: 403'],
                  },
                  { buildId: 'tpl%201:b', status: 'ready' as const, templateId: 'tpl-1' },
                  ...(this.printed
                    ? [
                        {
                          buildId: 'tpl-1:build-2',
                          status: 'failed' as const,
                          error: this.printed,
                          logs: [this.printed],
                        },
                      ]
                    : []),
                ]
              : [],
        };
        create(): never {
          throw new Error('not constructed in route tests');
        }
      }

      async function seedBuilding(sandbox = new BuildingSandbox()) {
        const seed = await createFactoryStorageForTests();
        const project = await seed.projects.create({ orgId: 'org-1', userId: 'user-1', input: { name: 'Env' } });
        const github = seed.sourceControl.forIntegration('github');
        const installation = await github.installations.upsert({
          orgId: 'org-1',
          connectedByUserId: 'user-1',
          externalId: 'gh-1',
        });
        const connection = await github.connections.create({
          orgId: 'org-1',
          factoryProjectId: project.id,
          installationId: installation.id,
          createdByUserId: 'user-1',
        });
        const repository = await github.repositories.upsert({
          orgId: 'org-1',
          input: { installationId: installation.id, externalId: 'acme/api', slug: 'acme/api', defaultBranch: 'main' },
        });
        await github.projectRepositories.link({
          orgId: 'org-1',
          connectionId: connection.id,
          repositoryId: repository.id,
          createdByUserId: 'user-1',
          sandboxProvider: 'platform',
          sandboxWorkdir: '/workspace',
        });
        let mastra: Mastra | undefined;
        const runner = new EnvironmentBuildRunner(
          {
            sandbox,
            projects: seed.projects,
            sandboxEnvs: seed.sandboxEnvs,
            sourceControl: {
              storage: github,
              versionControl: { getRepositoryAccess: async () => ({ token: 't', cloneUrl: 'u' }) as never },
            },
          },
          { getMastra: () => mastra, sleep: async () => {} },
        );
        mastra = new Mastra({
          logger: false,
          storage: new InMemoryStore({ id: `routes-builds-${project.id}` }),
          workflows: { [ENVIRONMENT_BUILD_WORKFLOW_ID]: runner.workflow },
          notifications: { dispatch: { enabled: false } },
        });
        await runner.probeSchedules();
        const app = new Hono();
        app.use('*', async (context, next) => {
          context.set('factoryAuthUser' as never, { id: 'user-1', organizationId: 'org-1' } as never);
          await next();
        });
        mountApiRoutes(
          app as never,
          projectRoutes(seed, ['github'], undefined, undefined, { sandbox, environmentBuilds: runner }),
        );
        return { seed, project, app, sandbox, runner, mastra };
      }

      const read = async (app: Hono, projectId: string) =>
        (
          (await (await app.request(`/web/factory/projects/${projectId}/environment`)).json()) as {
            environment: Record<string, any>;
          }
        ).environment;

      const until = async (check: () => Promise<boolean>) => {
        for (let i = 0; i < 100 && !(await check()); i += 1) await new Promise(r => setTimeout(r, 20));
      };

      it('masks Build variable values in provider build errors and logs', async () => {
        const { app, project, sandbox, seed } = await seedBuilding();
        await seed.sandboxEnvs.set(
          'org-1',
          project.id,
          { name: 'NPM_TOKEN', value: 'npm-sentinel-77', appliesTo: 'build' },
          'user-1',
        );
        sandbox.withHistory = true;
        sandbox.printed = 'auth failed for npm-sentinel-77';

        const history = await app.request(`/web/factory/projects/${project.id}/environment/builds`);
        expect(history.status).toBe(200);
        const historyText = await history.text();
        expect(historyText).not.toContain('npm-sentinel-77');
        expect(JSON.parse(historyText).builds.at(-1)).toEqual({
          buildId: 'tpl-1:build-2',
          status: 'failed',
          error: 'auth failed for ***',
          logs: ['auth failed for ***'],
        });

        const detail = await app.request(
          `/web/factory/projects/${project.id}/environment/builds/${encodeURIComponent('tpl-1:build-2')}`,
        );
        expect(detail.status).toBe(200);
        const detailText = await detail.text();
        expect(detailText).not.toContain('npm-sentinel-77');
        expect(JSON.parse(detailText).build).toMatchObject({ error: 'setup failed: auth failed for ***' });
      });

      it('reports triggers and the last build on GET without calling the provider', async () => {
        const { app, project, sandbox } = await seedBuilding();
        const environment = await read(app, project.id);
        expect(environment.sandbox.capabilities.builds).toEqual({ available: true, history: true });
        expect(environment.buildTriggers).toEqual({
          schedule: { enabled: false, cron: null, timezone: null, scheduleAvailable: true },
          push: { enabled: false, debounceMinutes: 10 },
        });
        expect(environment.build).toBeNull();
        expect(environment.buildRequested).toBeUndefined();
        expect(sandbox.reads).toEqual([]);
      });

      it('builds now, serves live status by id with heads from the stored template, then lists history', async () => {
        const { app, project, sandbox, seed } = await seedBuilding();
        const started = await app.request(`/web/factory/projects/${project.id}/environment/build`, { method: 'POST' });
        expect(started.status).toBe(200);
        expect(await started.json()).toEqual({
          outcome: 'started',
          buildId: 'tpl-1:build-1',
          templateId: 'tpl-1',
        });
        expect(sandbox.starts).toEqual([{ sessionId: `environment-build:${project.id}`, settings: {} }]);
        await until(async () => (await seed.projects.getById({ id: project.id }))?.activeTemplateId === 'tpl-1');
        expect(await seed.projects.getById({ id: project.id })).toMatchObject({
          activeTemplateId: 'tpl-1',
          activeTemplateHeads: { 'acme/api': SHA },
          lastBuildId: 'tpl-1:build-1',
        });
        expect((await read(app, project.id)).build).toMatchObject({ buildId: 'tpl-1:build-1' });

        const detail = await app.request(
          `/web/factory/projects/${project.id}/environment/builds/${encodeURIComponent('tpl-1:build-1')}`,
        );
        expect(detail.status).toBe(200);
        expect(await detail.json()).toEqual({
          build: { buildId: 'tpl-1:build-1', status: 'ready', templateId: 'tpl-1' },
        });
        // The route decoded the composite id and resolved heads from the pinned template, not GitHub.
        expect(sandbox.reads.at(-1)).toEqual({ buildId: 'tpl-1:build-1', heads: { api: SHA } });

        sandbox.withHistory = true;
        const history = await app.request(`/web/factory/projects/${project.id}/environment/builds`);
        expect(history.status).toBe(200);
        // Provider output is shown to the user with clone credentials stripped.
        expect(await history.json()).toEqual({
          builds: [
            { buildId: 'tpl-1:build-1', status: 'ready', templateId: 'tpl-1' },
            {
              buildId: 'tpl-1:build-0',
              status: 'failed',
              error: 'clone https://***@github.com/acme/api.git failed',
              logs: ['git clone https://***@github.com/acme/api.git', 'fatal: 403'],
            },
            { buildId: 'tpl%201:b', status: 'ready', templateId: 'tpl-1' },
          ],
        });

        // An id with a percent sign survives the path once, decoded by the router alone.
        const odd = await app.request(
          `/web/factory/projects/${project.id}/environment/builds/${encodeURIComponent('tpl%201:b')}`,
        );
        expect(odd.status).toBe(200);
        expect(sandbox.reads.at(-1)?.buildId).toBe('tpl%201:b');

        // An id the project does not own is never forwarded to the provider,
        // which would otherwise answer for any build on the host's account.
        const readsBefore = sandbox.reads.length;
        const foreign = await app.request(
          `/web/factory/projects/${project.id}/environment/builds/${encodeURIComponent('tpl-9:build-9')}`,
        );
        expect(foreign.status).toBe(404);
        expect(await foreign.json()).toEqual({ error: 'Build not found' });
        expect(sandbox.reads).toHaveLength(readsBefore);
      });

      it('never builds on save: repository patches, edits and unlinks only store the change', async () => {
        const { app, project, sandbox, seed } = await seedBuilding();
        const github = seed.sourceControl.forIntegration('github');
        const [link] = await github.projectRepositories.listByProject({ orgId: 'org-1', factoryProjectId: project.id });

        const patched = await patch(app, project.id, {
          repositories: [{ projectRepositoryId: link!.id, setupCommand: 'pnpm i' }],
        });
        expect(patched.status).toBe(200);
        expect((await patched.json()).environment).not.toHaveProperty('buildRequested');

        const edited = await app.request(`/web/factory/projects/${project.id}/repositories/${link!.id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ setupCommand: 'pnpm build' }),
        });
        expect(edited.status).toBe(200);

        const unlinked = await app.request(`/web/factory/projects/${project.id}/repositories/${link!.id}`, {
          method: 'DELETE',
        });
        expect(unlinked.status).toBe(204);
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(sandbox.starts).toEqual([]);
      });

      it('deletes the project schedule with the project', async () => {
        const { app, project, mastra } = await seedBuilding();
        const enabled = await patch(app, project.id, {
          buildTriggers: { schedule: { enabled: true, cron: '0 3 * * *' } },
        });
        expect(enabled.status).toBe(200);
        await expect(mastra!.schedules.get(scheduleIdFor(project.id))).resolves.toMatchObject({ cron: '0 3 * * *' });

        const deleted = await app.request(`/web/factory/projects/${project.id}`, { method: 'DELETE' });
        expect(deleted.status).toBe(204);
        await expect(mastra!.schedules.get(scheduleIdFor(project.id))).resolves.toBeNull();
      });

      it('answers 404 no_builds without a builds capability and no_history without list', async () => {
        const { seed, project } = await seedEnvironment();
        const plain = new Hono();
        plain.use('*', async (context, next) => {
          context.set('factoryAuthUser' as never, { id: 'user-1', organizationId: 'org-1' } as never);
          await next();
        });
        mountApiRoutes(
          plain as never,
          projectRoutes(seed, ['github'], undefined, undefined, { sandbox: new StubFactorySandbox() }),
        );
        for (const [path, method] of [
          ['/environment/build', 'POST'],
          ['/environment/builds', 'GET'],
          ['/environment/builds/x', 'GET'],
        ] as const) {
          const response = await plain.request(`/web/factory/projects/${project.id}${path}`, { method });
          expect([path, response.status, await response.json()]).toEqual([path, 404, { error: 'no_builds' }]);
        }
        expect((await patch(plain, project.id, { buildTriggers: { push: { enabled: true } } })).status).toBe(400);

        const sandbox = new BuildingSandbox();
        (sandbox.builds as { list?: unknown }).list = undefined;
        const { app, project: building } = await seedBuilding(sandbox);
        const response = await app.request(`/web/factory/projects/${building.id}/environment/builds`);
        expect([response.status, await response.json()]).toEqual([404, { error: 'no_history' }]);
      });

      it('saves settings and push triggers together without accepting triggers from an invalid patch', async () => {
        const { app, project, seed } = await seedBuilding();
        const response = await patch(app, project.id, {
          settings: { cpuCount: 8 },
          buildTriggers: { push: { enabled: true, debounceMinutes: 3 } },
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          environment: {
            settings: { cpuCount: 8 },
            buildTriggers: { push: { enabled: true, debounceMinutes: 3 } },
          },
        });

        const refused = await patch(app, project.id, {
          settings: { cpuCount: 0 },
          buildTriggers: { push: { enabled: false, debounceMinutes: 9 } },
        });
        expect(refused.status).toBe(400);
        expect(await seed.projects.getById({ id: project.id })).toMatchObject({
          sandboxSettings: { cpuCount: 8 },
          buildOnPushEnabled: true,
          buildPushDebounceMinutes: 3,
        });
      });

      it('stores push triggers, keeps the cron in core Schedules, and rejects a bad cron', async () => {
        const { app, project, mastra } = await seedBuilding();
        const pushed = await patch(app, project.id, { buildTriggers: { push: { enabled: true, debounceMinutes: 3 } } });
        expect(pushed.status).toBe(200);
        expect(((await pushed.json()) as any).environment.buildTriggers.push).toEqual({
          enabled: true,
          debounceMinutes: 3,
        });

        const bad = await patch(app, project.id, {
          buildTriggers: { schedule: { enabled: true, cron: 'not a cron' } },
        });
        expect(bad.status).toBe(400);
        expect(((await bad.json()) as any).issues[0].path).toEqual(['buildTriggers', 'schedule', 'cron']);
        expect((await patch(app, project.id, { buildTriggers: { schedule: { enabled: true } } })).status).toBe(400);

        const scheduled = await patch(app, project.id, {
          buildTriggers: { schedule: { enabled: true, cron: '0 3 * * *', timezone: 'UTC' } },
        });
        expect(scheduled.status).toBe(200);
        expect(((await scheduled.json()) as any).environment.buildTriggers.schedule).toEqual({
          enabled: true,
          cron: '0 3 * * *',
          timezone: 'UTC',
          scheduleAvailable: true,
        });
        const row = await mastra.schedules.get(scheduleIdFor(project.id));
        expect(row).toMatchObject({
          workflowId: ENVIRONMENT_BUILD_WORKFLOW_ID,
          cron: '0 3 * * *',
          status: 'active',
          inputData: { projectId: project.id, trigger: 'schedule' },
        });

        const paused = await patch(app, project.id, { buildTriggers: { schedule: { enabled: false } } });
        expect(((await paused.json()) as any).environment.buildTriggers.schedule).toMatchObject({
          enabled: false,
          cron: '0 3 * * *',
        });
        expect((await mastra.schedules.get(scheduleIdFor(project.id)))?.status).toBe('paused');
      });

      it('treats disabling a schedule that never existed as a no-op, with no cron', async () => {
        const { app, project, mastra } = await seedBuilding();

        const disabled = await patch(app, project.id, { buildTriggers: { schedule: { enabled: false } } });

        expect(disabled.status).toBe(200);
        expect(((await disabled.json()) as any).environment.buildTriggers.schedule).toMatchObject({ enabled: false });
        expect(await mastra.schedules.get(scheduleIdFor(project.id))).toBeNull();
      });

      it('saves a setting without building; Build now picks the new settings up', async () => {
        const { app, project, sandbox } = await seedBuilding();
        const changed = await patch(app, project.id, { settings: { cpuCount: 4 } });
        expect(changed.status).toBe(200);
        const body = (await changed.json()) as any;
        expect(body.environment.settings).toEqual({ cpuCount: 4 });
        expect(body.environment.build).toBeNull();
        expect(sandbox.starts).toEqual([]);

        const built = await app.request(`/web/factory/projects/${project.id}/environment/build`, { method: 'POST' });
        expect(built.status).toBe(200);
        expect(sandbox.starts).toEqual([{ sessionId: `environment-build:${project.id}`, settings: { cpuCount: 4 } }]);
      });
    });

    it('scopes the environment to the organization', async () => {
      const { seed, project, links } = await seedEnvironment();
      const app = new Hono();
      app.use('*', async (context, next) => {
        context.set('factoryAuthUser' as never, { id: 'user-2', organizationId: 'org-2' } as never);
        await next();
      });
      mountApiRoutes(app as never, projectRoutes(seed, ['github']));
      expect((await app.request(`/web/factory/projects/${project.id}/environment`)).status).toBe(404);
      expect(
        (await patch(app, project.id, { repositories: [{ projectRepositoryId: links[0]!.id, inEnvironment: false }] }))
          .status,
      ).toBe(404);
    });
  });
});
