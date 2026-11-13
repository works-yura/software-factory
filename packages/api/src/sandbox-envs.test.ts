import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import { CachedSandboxEnvs } from '@factory/sandbox';
import type { AuditEmitter } from '@factory/feed';
import { createFactoryStorageForTests } from '@factory/testing';
import { SandboxEnvRoutes } from './sandbox-envs.ts';
import { fakeRouteAuth, mountApiRoutes } from '@factory/http/testing';

const SENTINEL = 'sentinel-value-7f3a';

async function setup(
  options: {
    writable?: boolean;
    audit?: AuditEmitter;
    enabled?: boolean;
    admin?: boolean;
    isProjectRepository?: (scope: { projectRepositoryId: string }) => Promise<boolean>;
    onEnvironmentSaved?: (projectId: string) => void;
  } = {},
) {
  const seed = await createFactoryStorageForTests();
  // As in factory.ts; a frozen clock means only writes, never age, refresh it.
  const sandboxEnvs = new CachedSandboxEnvs(seed.sandboxEnvs, { now: () => 0 });
  const project = await seed.projects.create({ orgId: 'org-1', userId: 'user-1', input: { name: 'Platform' } });
  const other = await seed.projects.create({ orgId: 'org-2', userId: 'user-2', input: { name: 'Other' } });
  const app = new Hono();
  app.use('*', async (context, next) => {
    context.set('factoryAuthUser' as never, { id: 'user-1', organizationId: 'org-1' } as never);
    await next();
  });
  mountApiRoutes(
    app as never,
    new SandboxEnvRoutes({
      auth: fakeRouteAuth({
        enabled: options.enabled ?? true,
        isOrganizationAdmin: async () => options.admin ?? true,
      }),
      projects: seed.projects,
      sandboxEnvs,
      writable: options.writable ?? true,
      ...(options.audit ? { audit: options.audit } : {}),
      ...(options.isProjectRepository ? { isProjectRepository: options.isProjectRepository } : {}),
      ...(options.onEnvironmentSaved ? { onEnvironmentSaved: options.onEnvironmentSaved } : {}),
    }).routes(),
  );
  const base = `/web/factory/projects/${project.id}/sandbox-envs`;
  const send = (method: string, path: string, body?: unknown) =>
    app.request(`${base}${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
  const projectBase = `/web/factory/projects/${project.id}`;
  const sendTo = (method: string, path: string, body?: unknown) =>
    app.request(`${projectBase}${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
  return { seed, sandboxEnvs, project, other, app, base, send, sendTo };
}

describe('SandboxEnvRoutes', () => {
  it('sets, lists, updates and deletes a variable without ever returning its value', async () => {
    const audit = { emit: vi.fn(async () => {}) };
    const onEnvironmentSaved = vi.fn();
    const { seed, project, send } = await setup({ audit, onEnvironmentSaved });

    const put = await send('PUT', '/NPM_TOKEN', { value: SENTINEL, appliesTo: 'runtime' });
    expect(put.status).toBe(200);
    const putText = await put.text();
    expect(JSON.parse(putText)).toMatchObject({
      env: { name: 'NPM_TOKEN', appliesTo: 'runtime', updatedBy: 'user-1' },
    });

    const list = await send('GET', '');
    expect(list.status).toBe(200);
    const listText = await list.text();
    expect(JSON.parse(listText)).toEqual({
      envs: [
        {
          name: 'NPM_TOKEN',
          appliesTo: 'runtime',
          stage: 'development',
          updatedAt: expect.any(String),
          updatedBy: 'user-1',
        },
      ],
      writable: true,
      stages: ['development'],
      canManage: true,
    });

    const patch = await send('PATCH', '/NPM_TOKEN', { appliesTo: 'both' });
    expect(patch.status).toBe(200);
    const patchText = await patch.text();
    expect(JSON.parse(patchText)).toMatchObject({ env: { name: 'NPM_TOKEN', appliesTo: 'both' } });

    for (const text of [putText, listText, patchText]) {
      expect(text).not.toContain(SENTINEL);
      expect(text).not.toContain('"value"');
    }
    expect((await seed.sandboxEnvs.resolve('org-1', project.id)).build).toEqual({ NPM_TOKEN: SENTINEL });

    const del = await send('DELETE', '/NPM_TOKEN');
    expect(del.status).toBe(204);
    expect(await seed.sandboxEnvs.list('org-1', project.id)).toEqual([]);
    for (const missing of [
      await send('DELETE', '/NPM_TOKEN'),
      await send('PATCH', '/NPM_TOKEN', { appliesTo: 'build' }),
    ]) {
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({ error: 'Variable not found', message: 'Variable not found.' });
    }

    expect(audit.emit.mock.calls.map(([args]) => args.input)).toEqual([
      {
        action: 'factory.sandbox_env.set',
        factoryProjectId: project.id,
        targets: [{ type: 'sandbox_env', id: 'NPM_TOKEN', name: 'NPM_TOKEN' }],
        metadata: { appliesTo: 'runtime', stage: 'development' },
      },
      {
        action: 'factory.sandbox_env.updated',
        factoryProjectId: project.id,
        targets: [{ type: 'sandbox_env', id: 'NPM_TOKEN', name: 'NPM_TOKEN' }],
        metadata: { appliesTo: 'both', stage: 'development' },
      },
      {
        action: 'factory.sandbox_env.deleted',
        factoryProjectId: project.id,
        targets: [{ type: 'sandbox_env', id: 'NPM_TOKEN', name: 'NPM_TOKEN' }],
      },
    ]);
    expect(JSON.stringify(audit.emit.mock.calls)).not.toContain(SENTINEL);
    // Build variables are template inputs: every stored change, and only those, hands the project to builds.
    expect(onEnvironmentSaved.mock.calls).toEqual([[project.id], [project.id], [project.id]]);
  });

  it('marks every response no-store, including errors', async () => {
    const { send, app } = await setup();
    for (const response of [
      await send('GET', ''),
      await send('PUT', '/A', { value: 'x', appliesTo: 'build' }),
      await send('PATCH', '/A', { appliesTo: 'runtime' }),
      await send('DELETE', '/A'),
      await send('PUT', '/GH_TOKEN', { value: 'x', appliesTo: 'build' }),
      await app.request('/web/factory/projects/not-a-uuid/sandbox-envs'),
    ]) {
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
  });

  it('rejects invalid and reserved names, naming the variable', async () => {
    const { send } = await setup();
    for (const name of ['1ABC', 'HAS-DASH', 'A'.repeat(129)]) {
      expect((await send('PUT', `/${name}`, { value: 'x', appliesTo: 'runtime' })).status).toBe(400);
    }
    for (const name of [
      'GH_TOKEN',
      'GH_TOKEN_2',
      'MASTRA_REPOSITORY_ACCESS_TOKEN',
      'MASTRA_REPOSITORY_ACCESS_TOKEN_1',
      'MASTRA_BUILD_ENV_REVISION',
    ]) {
      const response = await send('PUT', `/${name}`, { value: 'x', appliesTo: 'runtime' });
      expect(response.status, name).toBe(400);
      expect(((await response.json()) as { message: string }).message).toBe(
        `${name}: This name is reserved by Factory.`,
      );
    }
    for (const name of ['__proto__', 'toString', 'constructor', 'hasOwnProperty']) {
      const response = await send('PUT', `/${name}`, { value: 'x', appliesTo: 'runtime' });
      expect(response.status, name).toBe(400);
      expect(((await response.json()) as { message: string }).message).toBe(`${name}: This name can't be used.`);
    }
    expect((await send('PUT', `/${'A'.repeat(128)}`, { value: 'x', appliesTo: 'runtime' })).status).toBe(200);
    expect((await send('PUT', '/GH_TOKENS', { value: 'x', appliesTo: 'runtime' })).status).toBe(200);
  });

  it('drops the cached revision on every write, so the next command in this process reloads', async () => {
    const { sandboxEnvs, project, send } = await setup();
    const read = async () => (await sandboxEnvs.revisions('org-1', project.id))?.revision;
    const seen = [await read()];
    expect((await send('PUT', '/A', { value: 'x', appliesTo: 'runtime' })).status).toBe(200);
    seen.push(await read());
    expect((await send('PATCH', '/A', { appliesTo: 'both' })).status).toBe(200);
    seen.push(await read());
    expect((await send('DELETE', '/A')).status).toBe(204);
    seen.push(await read());
    expect(new Set(seen).size).toBe(4);
  });

  it('rejects oversized values, bad applies-to and non-JSON bodies', async () => {
    const { send, base, app } = await setup();
    expect((await send('PUT', '/BIG', { value: 'x'.repeat(32 * 1024 + 1), appliesTo: 'runtime' })).status).toBe(400);
    expect((await send('PUT', '/BIG', { value: 'x'.repeat(32 * 1024), appliesTo: 'runtime' })).status).toBe(200);
    expect((await send('PUT', '/A', { value: 'x', appliesTo: 'always' })).status).toBe(400);
    const badPatch = await send('PATCH', '/BIG', { appliesTo: 'always' });
    expect(badPatch.status).toBe(400);
    expect(await badPatch.json()).toMatchObject({ error: 'invalid_sandbox_env', message: expect.any(String) });
    expect((await send('PUT', '/A', { appliesTo: 'runtime' })).status).toBe(400);
    const nul = await send('PUT', '/A', { value: 'x\0y', appliesTo: 'runtime' });
    expect(nul.status).toBe(400);
    expect(await nul.json()).toEqual({ error: 'invalid_sandbox_env', message: "Values can't contain NUL characters." });
    const form = await app.request(`${base}/A`, {
      method: 'PUT',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `value=${SENTINEL}&appliesTo=runtime`,
    });
    expect(form.status).toBe(415);
    expect(await form.text()).not.toContain(SENTINEL);
  });

  it("returns 404 for another org's project and unknown ids", async () => {
    const { app, other, seed } = await setup();
    await seed.sandboxEnvs.set('org-2', other.id, { name: 'THEIRS', value: SENTINEL, appliesTo: 'runtime' }, 'user-2');
    const path = `/web/factory/projects/${other.id}/sandbox-envs`;
    expect((await app.request(path)).status).toBe(404);
    const put = await app.request(`${path}/THEIRS`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'mine', appliesTo: 'runtime' }),
    });
    expect(put.status).toBe(404);
    expect((await app.request(`${path}/THEIRS`, { method: 'DELETE' })).status).toBe(404);
    expect((await seed.sandboxEnvs.resolve('org-2', other.id)).runtime).toEqual({ THEIRS: SENTINEL });
    expect((await app.request('/web/factory/projects/not-a-uuid/sandbox-envs')).status).toBe(404);
  });

  it('refuses writes with 409 and reports writable: false when values would be stored unencrypted', async () => {
    const { send, seed, project } = await setup({ writable: false });
    expect(await (await send('GET', '')).json()).toEqual({
      envs: [],
      writable: false,
      stages: ['development'],
      canManage: true,
    });
    const put = await send('PUT', '/A', { value: SENTINEL, appliesTo: 'runtime' });
    expect(put.status).toBe(409);
    expect(await put.json()).toMatchObject({ error: 'encryption_not_configured' });
    expect((await send('PATCH', '/A', { appliesTo: 'build' })).status).toBe(409);
    expect(await seed.sandboxEnvs.list('org-1', project.id)).toEqual([]);

    // A value stored before the key went missing can still be removed.
    await seed.sandboxEnvs.set('org-1', project.id, { name: 'OLD', value: 'x', appliesTo: 'runtime' }, 'user-1');
    expect((await send('DELETE', '/OLD')).status).toBe(204);
  });

  it('accepts writes with auth off and no key', async () => {
    const { send } = await setup({ enabled: false, writable: true });
    expect((await send('PUT', '/A', { value: 'x', appliesTo: 'runtime' })).status).toBe(200);
    expect(await (await send('GET', '')).json()).toMatchObject({ writable: true });
  });

  it('keeps the write when the audit emitter throws', async () => {
    const audit = { emit: vi.fn(async () => Promise.reject(new Error('unknown action'))) };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { send, seed, project } = await setup({ audit });
    expect((await send('PUT', '/A', { value: SENTINEL, appliesTo: 'build' })).status).toBe(200);
    expect((await send('PATCH', '/A', { appliesTo: 'both' })).status).toBe(200);
    expect((await send('DELETE', '/A')).status).toBe(204);
    expect(audit.emit).toHaveBeenCalledTimes(3);
    expect(await seed.sandboxEnvs.list('org-1', project.id)).toEqual([]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(SENTINEL);
    warn.mockRestore();
  });

  it("sets a variable's stage and keeps it off sandboxes until that stage is enabled", async () => {
    const { send, seed, project } = await setup();
    expect((await send('PUT', '/STAGED', { value: 'x', appliesTo: 'runtime', stage: 'staging' })).status).toBe(200);
    expect((await send('PUT', '/PROD', { value: 'p', appliesTo: 'runtime', stage: 'production' })).status).toBe(200);
    expect((await seed.sandboxEnvs.resolve('org-1', project.id)).runtime).toEqual({});
    const patch = await send('PATCH', '/STAGED', { stage: 'development' });
    expect(await patch.json()).toMatchObject({ env: { name: 'STAGED', stage: 'development', appliesTo: 'runtime' } });
    expect((await seed.sandboxEnvs.resolve('org-1', project.id)).runtime).toEqual({ STAGED: 'x' });
    expect((await send('PATCH', '/STAGED', {})).status).toBe(400);
    expect((await send('PATCH', '/STAGED', { stage: 'qa' })).status).toBe(400);
  });
});

describe('sandbox stages', () => {
  it('lets an admin enable staging, never production, and always keeps development', async () => {
    const audit = { emit: vi.fn(async () => {}) };
    const { sendTo, send, seed, project } = await setup({ audit });
    const put = await sendTo('PUT', '/sandbox-stages', { stages: ['development', 'staging'] });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ stages: ['development', 'staging'] });
    expect(await (await send('GET', '')).json()).toMatchObject({ stages: ['development', 'staging'] });
    expect(await seed.sandboxEnvs.stages('org-1', project.id)).toEqual(['development', 'staging']);

    for (const stages of [['development', 'production'], ['staging'], 'staging']) {
      expect((await sendTo('PUT', '/sandbox-stages', { stages })).status, JSON.stringify(stages)).toBe(400);
    }
    expect(await seed.sandboxEnvs.stages('org-1', project.id)).toEqual(['development', 'staging']);
    expect(audit.emit.mock.calls.map(([args]) => args.input)).toEqual([
      expect.objectContaining({ action: 'factory.sandbox_env.stages_updated', metadata: { stages: ['development', 'staging'] } }),
    ]);
  });

  it('refuses a member, who still sees the stages', async () => {
    const { sendTo, send } = await setup({ admin: false });
    const put = await sendTo('PUT', '/sandbox-stages', { stages: ['development', 'staging'] });
    expect(put.status).toBe(403);
    expect(await put.json()).toMatchObject({ error: 'organization_admin_required' });
    expect(await (await send('GET', '')).json()).toMatchObject({ stages: ['development'], canManage: false });
  });
});

describe('env files', () => {
  const LINK = '11111111-1111-4111-8111-111111111111';
  const create = (sendTo: (method: string, path: string, body?: unknown) => Promise<Response>, body: object) =>
    sendTo('POST', '/sandbox-env-files', { projectRepositoryId: LINK, stage: 'development', content: '', ...body });

  it('lets an admin add, list, reveal, edit and delete a file; lists and writes never carry its content', async () => {
    const audit = { emit: vi.fn(async () => {}) };
    const { sendTo, seed, project } = await setup({ audit });
    const created = await create(sendTo, { path: 'apps/mobile/.env.staging', stage: 'staging', content: `API=${SENTINEL}\n` });
    expect(created.status).toBe(200);
    const createdText = await created.text();
    const { file } = JSON.parse(createdText) as { file: { id: string } };
    expect(JSON.parse(createdText)).toEqual({
      file: {
        id: expect.any(String),
        projectRepositoryId: LINK,
        path: 'apps/mobile/.env.staging',
        stage: 'staging',
        size: SENTINEL.length + 5,
        updatedAt: expect.any(String),
        updatedBy: 'user-1',
      },
    });

    const list = await sendTo('GET', '/sandbox-env-files');
    const listText = await list.text();
    expect(JSON.parse(listText)).toMatchObject({ files: [{ id: file.id, path: 'apps/mobile/.env.staging' }], writable: true, canManage: true });

    const reveal = await sendTo('GET', `/sandbox-env-files/${file.id}`);
    expect(reveal.status).toBe(200);
    expect(reveal.headers.get('cache-control')).toBe('no-store');
    expect(await reveal.json()).toMatchObject({ file: { id: file.id, content: `API=${SENTINEL}\n` } });

    const patch = await sendTo('PATCH', `/sandbox-env-files/${file.id}`, { content: 'API=next\n', stage: 'development' });
    const patchText = await patch.text();
    expect(JSON.parse(patchText)).toMatchObject({ file: { stage: 'development', size: 9 } });
    expect((await seed.sandboxEnvs.resolve('org-1', project.id)).files).toEqual([
      expect.objectContaining({ path: 'apps/mobile/.env.staging', content: 'API=next\n' }),
    ]);
    for (const text of [createdText, listText, patchText]) {
      expect(text).not.toContain(SENTINEL);
      expect(text).not.toContain('"content"');
    }

    expect((await sendTo('DELETE', `/sandbox-env-files/${file.id}`)).status).toBe(204);
    expect((await sendTo('DELETE', `/sandbox-env-files/${file.id}`)).status).toBe(404);
    expect((await sendTo('GET', `/sandbox-env-files/${file.id}`)).status).toBe(404);
    expect(audit.emit.mock.calls.map(([args]) => args.input.action)).toEqual([
      'factory.sandbox_env.file_created',
      'factory.sandbox_env.file_updated',
      'factory.sandbox_env.file_deleted',
    ]);
    expect(JSON.stringify(audit.emit.mock.calls)).not.toContain(SENTINEL);
  });

  it('shows a member paths and stages only, and refuses reveal and every write', async () => {
    const { sendTo, seed, project } = await setup({ admin: false });
    const stored = await seed.sandboxEnvs.createFile(
      'org-1',
      project.id,
      { projectRepositoryId: LINK, path: '.env', stage: 'development', content: SENTINEL },
      'admin',
    );
    const list = await sendTo('GET', '/sandbox-env-files');
    expect(list.status).toBe(200);
    const listText = await list.text();
    expect(JSON.parse(listText)).toMatchObject({ files: [{ path: '.env', size: SENTINEL.length }], canManage: false });
    expect(listText).not.toContain(SENTINEL);
    for (const response of [
      await sendTo('GET', `/sandbox-env-files/${stored.id}`),
      await create(sendTo, { path: '.env.local' }),
      await sendTo('PATCH', `/sandbox-env-files/${stored.id}`, { content: 'mine' }),
      await sendTo('DELETE', `/sandbox-env-files/${stored.id}`),
    ]) {
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain(SENTINEL);
    }
    expect((await seed.sandboxEnvs.getFile('org-1', project.id, stored.id))?.content).toBe(SENTINEL);
  });

  it('validates paths, sizes and the repository, and refuses a taken path', async () => {
    const { sendTo } = await setup({ isProjectRepository: async ({ projectRepositoryId }) => projectRepositoryId === LINK });
    for (const path of ['../.env', '/etc/passwd', '.git/config', 'a/../../b', 'with space', '']) {
      const response = await create(sendTo, { path });
      expect(response.status, path).toBe(400);
      expect(await response.json()).toMatchObject({ error: 'invalid_env_file' });
    }
    expect((await create(sendTo, { path: '.env', content: 'x'.repeat(64 * 1024 + 1) })).status).toBe(400);
    expect((await create(sendTo, { path: '.env', content: 'a\0b' })).status).toBe(400);
    expect((await create(sendTo, { path: '.env', stage: 'qa' })).status).toBe(400);
    expect((await create(sendTo, { path: '.env', projectRepositoryId: '22222222-2222-4222-8222-222222222222' })).status).toBe(404);
    expect((await create(sendTo, { path: '.env', projectRepositoryId: 'not-a-uuid' })).status).toBe(400);
    expect((await create(sendTo, { path: '.env' })).status).toBe(200);
    const taken = await create(sendTo, { path: '.env', stage: 'staging' });
    expect(taken.status).toBe(409);
    expect(await taken.json()).toMatchObject({ error: 'env_file_path_taken' });
    const other = await create(sendTo, { path: '.env.staging' });
    const { file } = (await other.json()) as { file: { id: string } };
    expect((await sendTo('PATCH', `/sandbox-env-files/${file.id}`, { path: '.env' })).status).toBe(409);
    expect((await sendTo('PATCH', `/sandbox-env-files/${file.id}`, { path: '../x' })).status).toBe(400);
    expect((await sendTo('PATCH', `/sandbox-env-files/${file.id}`, {})).status).toBe(400);
    expect((await sendTo('GET', '/sandbox-env-files/not-a-uuid')).status).toBe(404);
  });

  it('refuses adding or editing without encryption, but still deletes', async () => {
    const { sendTo, seed, project } = await setup({ writable: false });
    expect((await create(sendTo, { path: '.env' })).status).toBe(409);
    const stored = await seed.sandboxEnvs.createFile(
      'org-1',
      project.id,
      { projectRepositoryId: LINK, path: '.env', stage: 'development', content: 'x' },
      'admin',
    );
    expect((await sendTo('PATCH', `/sandbox-env-files/${stored.id}`, { content: 'y' })).status).toBe(409);
    expect((await sendTo('DELETE', `/sandbox-env-files/${stored.id}`)).status).toBe(204);
  });

  it("returns 404 for another org's project", async () => {
    const { app, other, seed } = await setup();
    const stored = await seed.sandboxEnvs.createFile(
      'org-2',
      other.id,
      { projectRepositoryId: LINK, path: '.env', stage: 'development', content: SENTINEL },
      'user-2',
    );
    const base = `/web/factory/projects/${other.id}/sandbox-env-files`;
    expect((await app.request(base)).status).toBe(404);
    const reveal = await app.request(`${base}/${stored.id}`);
    expect(reveal.status).toBe(404);
    expect(await reveal.text()).not.toContain(SENTINEL);
  });
});
