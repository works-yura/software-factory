import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { fakeRouteAuth, mountApiRoutes } from '@factory/http/testing';
import { createFactoryStorageForTests } from '@factory/testing';

import { buildOpenCodeLocalSessionRoutes } from './local-session-routes.ts';
import type { OpenCodeLocalSessionHistory, OpenCodeLocalSessionsService } from './local-session-routes.ts';
import type { ClaudeCodeUserSessions } from '@factory/api';

const user = { id: 'user-1', organizationId: 'org-1' };

async function seeded() {
  const seed = await createFactoryStorageForTests();
  const sourceControl = seed.sourceControl.forIntegration('github');
  const project = await seed.projects.create({ orgId: 'org-1', userId: 'user-1', input: { name: 'Syncta' } });
  const installation = await sourceControl.installations.upsert({ orgId: 'org-1', connectedByUserId: 'user-1', externalId: 'inst-1' });
  const connection = await sourceControl.connections.create({ orgId: 'org-1', factoryProjectId: project.id, installationId: installation.id, createdByUserId: 'user-1' });
  const link = async (slug: string, externalId: string) => {
    const repository = await sourceControl.repositories.upsert({ orgId: 'org-1', input: { installationId: installation.id, externalId, slug, defaultBranch: 'main' } });
    return sourceControl.projectRepositories.link({
      orgId: 'org-1',
      connectionId: connection.id,
      repositoryId: repository.id,
      createdByUserId: 'user-1',
      sandboxProvider: 'local',
      sandboxWorkdir: `/workspace/${externalId}`,
    });
  };
  const back = await link('Eclipt-AI/syncta_back', 'r1');
  const docs = await link('Eclipt-AI/syncta-docs', 'r2');
  return { seed, sourceControl, project, back, docs };
}

function fakeHarness() {
  const started: Array<{ sessionId: string; harness?: string; resourceId: string }> = [];
  const claudeCode: ClaudeCodeUserSessions = {
    harnesses: ['claude-code', 'opencode'],
    get: async () => undefined,
    start: async ({ session, resourceId, harness }) => {
      started.push({ sessionId: session.sessionId, resourceId, ...(harness ? { harness } : {}) });
    },
  };
  return { claudeCode, started };
}

function fakeLocal(options: { unreadable?: string } = {}) {
  const written: Array<{ sessionId: string; history: OpenCodeLocalSessionHistory }> = [];
  const service: OpenCodeLocalSessionsService = {
    list: async () => [
      { id: 'ses_a', title: 'Fix login', directory: '/work/back', updatedAt: '2026-11-14T10:00:00.000Z', messages: 4, repositorySlug: 'eclipt-ai/SYNCTA_BACK' },
      { id: 'ses_b', title: 'Idea', directory: '/tmp/idea', updatedAt: '2026-11-13T10:00:00.000Z', messages: 2 },
    ],
    read: async id => {
      if (options.unreadable) throw new Error(options.unreadable);
      return { title: id === 'ses_a' ? 'Fix login' : 'Idea', directory: '/work/back', turns: 2 };
    },
    write: async (sessionId, history) => {
      written.push({ sessionId, history });
    },
  };
  return { service, written };
}

function app(data: Awaited<ReturnType<typeof seeded>>, claudeCode: ClaudeCodeUserSessions | undefined, service: OpenCodeLocalSessionsService | undefined) {
  const hono = new Hono();
  hono.use('*', async (c, next) => {
    c.set('factoryAuthUser' as never, user as never);
    await next();
  });
  mountApiRoutes(
    hono as never,
    buildOpenCodeLocalSessionRoutes({
      auth: fakeRouteAuth(),
      sourceControls: [data.sourceControl],
      projects: data.seed.projects,
      memorySettings: data.seed.memorySettings,
      ...(claudeCode ? { claudeCode } : {}),
      ...(service ? { opencodeLocalSessions: service } : {}),
    }),
  );
  return hono;
}

describe('the person’s own OpenCode sessions, continued in the Factory', () => {
  it('has no routes where the server is not the person’s own machine', async () => {
    const data = await seeded();
    const response = await app(data, fakeHarness().claudeCode, undefined).request(`/web/opencode/local-sessions?factoryProjectId=${data.project.id}`);
    expect(response.status).toBe(404);
  });

  it('lists the sessions with the Factory repository their folder is a clone of', async () => {
    const data = await seeded();
    const response = await app(data, fakeHarness().claudeCode, fakeLocal().service).request(`/web/opencode/local-sessions?factoryProjectId=${data.project.id}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { sessions: Array<{ id: string; projectRepositoryId?: string }>; repositories: Array<{ slug: string }> };
    expect(body.repositories.map(choice => choice.slug).sort()).toEqual(['Eclipt-AI/syncta-docs', 'Eclipt-AI/syncta_back']);
    expect(body.sessions.map(session => [session.id, session.projectRepositoryId ?? null])).toEqual([
      ['ses_a', data.back.id],
      ['ses_b', null],
    ]);
  });

  it('continues one as a private OpenCode session on the chosen repository, with its history', async () => {
    const data = await seeded();
    const harness = fakeHarness();
    const local = fakeLocal();
    const response = await app(data, harness.claudeCode, local.service).request('/web/opencode/local-sessions/ses_a/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectRepositoryId: data.docs.id }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { session: { sessionId: string; harness: string; visibility: string; title: string }; imported: { turns: number } };
    expect(body.session).toMatchObject({ harness: 'opencode', visibility: 'private', title: 'Fix login' });
    expect(body.imported).toEqual({ turns: 2 });
    expect(harness.started).toEqual([{ sessionId: body.session.sessionId, resourceId: 'user-1', harness: 'opencode' }]);
    expect(local.written.map(entry => entry.sessionId)).toEqual([body.session.sessionId]);
    const row = await data.sourceControl.sessions.getBySessionId(body.session.sessionId);
    expect(row).toMatchObject({ projectRepositoryId: data.docs.id, userId: 'user-1', branch: `user/session-${body.session.sessionId}` });
  });

  it('creates nothing when the history cannot be read', async () => {
    const data = await seeded();
    const harness = fakeHarness();
    const response = await app(data, harness.claudeCode, fakeLocal({ unreadable: 'No OpenCode database at /x' }).service).request('/web/opencode/local-sessions/ses_a/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectRepositoryId: data.back.id }),
    });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { message: string }).message).toContain('No OpenCode database');
    expect(harness.started).toEqual([]);
    expect(await data.sourceControl.sessions.listByProjectRepository({ projectRepositoryId: data.back.id })).toEqual([]);
  });

  it('refuses a repository of another organization and a server without OpenCode', async () => {
    const data = await seeded();
    const unknown = await app(data, fakeHarness().claudeCode, fakeLocal().service).request('/web/opencode/local-sessions/ses_a/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectRepositoryId: 'nope' }),
    });
    expect(unknown.status).toBe(404);
    const noOpenCode = await app(data, undefined, fakeLocal().service).request('/web/opencode/local-sessions/ses_a/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectRepositoryId: data.back.id }),
    });
    expect(noOpenCode.status).toBe(409);
  });
});
