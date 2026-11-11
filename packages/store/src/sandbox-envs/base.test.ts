import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FactoryStorageDomain } from '@mastra/core/storage';
import type { CollectionSchema } from '@mastra/core/storage';
import { LibSQLFactoryStorage } from '@mastra/libsql';
import { describe, expect, it, onTestFinished } from 'vitest';

import { createFactorySecretEncryption } from '../secret-encryption.ts';
import { SANDBOX_ENVS_SCHEMA, SandboxEnvFilePathTakenError, SandboxEnvsStorage, sandboxEnvFilePathProblem } from './base.ts';

const testKey = { id: 'v1', key: new Uint8Array(32).fill(7) };
const ORG = 'org-1';
const PROJECT = 'proj-1';

async function makeStore(encrypted = true) {
  const backend = new LibSQLFactoryStorage({ id: 'sandbox-envs-test', url: ':memory:' });
  const domain = backend.registerDomain(
    new SandboxEnvsStorage(encrypted ? createFactorySecretEncryption({ primary: testKey }) : undefined),
  );
  await backend.init();
  onTestFinished(() => backend.close());
  return { ops: backend.ops, domain };
}

describe('SandboxEnvsStorage', () => {
  it('encrypts values saved before a key was configured once Factory boots with one', async () => {
    const url = `file:${join(mkdtempSync(join(tmpdir(), 'factory-envs-')), 'envs.db')}`;
    const boot = async (encrypted: boolean) => {
      const backend = new LibSQLFactoryStorage({ id: 'sandbox-envs-reencrypt-test', url });
      const domain = backend.registerDomain(
        new SandboxEnvsStorage(encrypted ? createFactorySecretEncryption({ primary: testKey }) : undefined),
      );
      await backend.init();
      return { backend, domain };
    };
    const plain = await boot(false);
    await plain.domain.set(ORG, PROJECT, { name: 'NPM_TOKEN', value: 'sentinel-secret', appliesTo: 'runtime' }, 'u');
    await plain.backend.close();

    const keyed = await boot(true);
    onTestFinished(() => keyed.backend.close());
    const [row] = await keyed.backend.ops.findMany<{ value: string }>('factory_sandbox_envs', {});
    expect(row!.value.startsWith('mastra:factory-secret:v1:')).toBe(true);
    expect(row!.value).not.toContain('sentinel-secret');
    expect((await keyed.domain.resolve(ORG, PROJECT)).runtime).toEqual({ NPM_TOKEN: 'sentinel-secret' });
  });

  it('stores values as encrypted envelopes and lists metadata only', async () => {
    const { ops, domain } = await makeStore();
    await domain.set(ORG, PROJECT, { name: 'NPM_TOKEN', value: 'sentinel-secret', appliesTo: 'both' }, 'user-1');

    const [row] = await ops.findMany<{ value: string }>('factory_sandbox_envs', {});
    expect(row!.value.startsWith('mastra:factory-secret:v1:')).toBe(true);
    expect(row!.value).not.toContain('sentinel-secret');

    const listed = await domain.list(ORG, PROJECT);
    expect(listed).toEqual([
      expect.objectContaining({ name: 'NPM_TOKEN', appliesTo: 'both', createdBy: 'user-1', updatedBy: 'user-1' }),
    ]);
    expect(Object.keys(listed[0]!)).not.toContain('value');
    expect(JSON.stringify(listed)).not.toContain('sentinel-secret');
  });

  it('resolves values split by where they apply', async () => {
    const { domain } = await makeStore();
    await domain.set(ORG, PROJECT, { name: 'BUILD_ONLY', value: 'b', appliesTo: 'build' }, 'u');
    await domain.set(ORG, PROJECT, { name: 'RUNTIME_ONLY', value: 'r', appliesTo: 'runtime' }, 'u');
    await domain.set(ORG, PROJECT, { name: 'EVERYWHERE', value: 'e', appliesTo: 'both' }, 'u');

    const resolved = await domain.resolve(ORG, PROJECT);
    expect(resolved.build).toEqual({ BUILD_ONLY: 'b', EVERYWHERE: 'e' });
    expect(resolved.runtime).toEqual({ RUNTIME_ONLY: 'r', EVERYWHERE: 'e' });
    expect(resolved).toMatchObject((await domain.revisions(ORG, PROJECT))!);
  });

  it('upserts by name, keeping one row per project', async () => {
    const { ops, domain } = await makeStore();
    await domain.set(ORG, PROJECT, { name: 'A', value: 'one', appliesTo: 'runtime' }, 'creator');
    await domain.set(ORG, PROJECT, { name: 'A', value: 'two', appliesTo: 'runtime' }, 'editor');
    expect(await ops.findMany('factory_sandbox_envs', {})).toHaveLength(1);
    expect((await domain.resolve(ORG, PROJECT)).runtime).toEqual({ A: 'two' });
    expect(await domain.list(ORG, PROJECT)).toEqual([
      expect.objectContaining({ createdBy: 'creator', updatedBy: 'editor' }),
    ]);
  });

  it('bumps the revision on every write and the build revision only on build-affecting writes', async () => {
    const { domain } = await makeStore();
    expect(await domain.revisions(ORG, PROJECT)).toBeNull();

    const steps: Array<[string, () => Promise<unknown>, boolean]> = [
      ['add runtime', () => domain.set(ORG, PROJECT, { name: 'R', value: '1', appliesTo: 'runtime' }, 'u'), false],
      ['edit runtime', () => domain.set(ORG, PROJECT, { name: 'R', value: '2', appliesTo: 'runtime' }, 'u'), false],
      ['add build', () => domain.set(ORG, PROJECT, { name: 'B', value: '1', appliesTo: 'build' }, 'u'), true],
      ['edit build', () => domain.set(ORG, PROJECT, { name: 'B', value: '2', appliesTo: 'build' }, 'u'), true],
      ['runtime to both', () => domain.updateAppliesTo(ORG, PROJECT, 'R', 'both', 'u'), true],
      ['both to build', () => domain.updateAppliesTo(ORG, PROJECT, 'R', 'build', 'u'), false],
      ['build to runtime', () => domain.updateAppliesTo(ORG, PROJECT, 'R', 'runtime', 'u'), true],
      [
        'set build var to runtime',
        () => domain.set(ORG, PROJECT, { name: 'B', value: '2', appliesTo: 'runtime' }, 'u'),
        true,
      ],
      ['delete runtime', () => domain.delete(ORG, PROJECT, 'B'), false],
      ['add both', () => domain.set(ORG, PROJECT, { name: 'X', value: '1', appliesTo: 'both' }, 'u'), true],
      ['delete both', () => domain.delete(ORG, PROJECT, 'X'), true],
    ];
    let before = (await domain.revisions(ORG, PROJECT)) ?? { revision: '', buildRevision: '' };
    for (const [label, write, buildChanges] of steps) {
      await write();
      const after = (await domain.revisions(ORG, PROJECT))!;
      expect(after.revision, label).not.toBe(before.revision);
      if (buildChanges) expect(after.buildRevision, label).not.toBe(before.buildRevision);
      else expect(after.buildRevision, label).toBe(before.buildRevision);
      before = after;
    }
  });

  it('leaves revisions alone for a no-op applies-to change or a missing variable', async () => {
    const { domain } = await makeStore();
    await domain.set(ORG, PROJECT, { name: 'R', value: '1', appliesTo: 'runtime' }, 'u');
    const before = await domain.revisions(ORG, PROJECT);
    await domain.updateAppliesTo(ORG, PROJECT, 'R', 'runtime', 'u');
    expect(await domain.updateAppliesTo(ORG, PROJECT, 'MISSING', 'both', 'u')).toBeNull();
    expect(await domain.delete(ORG, PROJECT, 'MISSING')).toBe(false);
    expect(await domain.revisions(ORG, PROJECT)).toEqual(before);
  });

  it('deletes the row so it no longer resolves', async () => {
    const { domain } = await makeStore();
    await domain.set(ORG, PROJECT, { name: 'R', value: '1', appliesTo: 'both' }, 'u');
    expect(await domain.delete(ORG, PROJECT, 'R')).toBe(true);
    expect(await domain.list(ORG, PROJECT)).toEqual([]);
    expect(await domain.resolve(ORG, PROJECT)).toMatchObject({ runtime: {}, build: {} });
  });

  it('isolates organizations and projects', async () => {
    const { domain } = await makeStore();
    await domain.set(ORG, PROJECT, { name: 'SHARED', value: 'mine', appliesTo: 'both' }, 'u');
    await domain.set('org-2', PROJECT, { name: 'SHARED', value: 'other-org', appliesTo: 'both' }, 'u');
    await domain.set(ORG, 'proj-2', { name: 'SHARED', value: 'other-project', appliesTo: 'both' }, 'u');

    expect((await domain.resolve(ORG, PROJECT)).runtime).toEqual({ SHARED: 'mine' });
    expect((await domain.resolve('org-2', PROJECT)).runtime).toEqual({ SHARED: 'other-org' });
    expect((await domain.resolve(ORG, 'proj-2')).runtime).toEqual({ SHARED: 'other-project' });

    await domain.delete('org-2', PROJECT, 'SHARED');
    expect((await domain.resolve(ORG, PROJECT)).runtime).toEqual({ SHARED: 'mine' });
    expect(await domain.list('org-3', PROJECT)).toEqual([]);
    expect(await domain.revisions('org-3', PROJECT)).toBeNull();
  });

  it('writes the variable row before the revision, so a new revision never shows old values', async () => {
    const { ops, domain } = await makeStore();
    await domain.set(ORG, PROJECT, { name: 'R', value: 'old', appliesTo: 'runtime' }, 'u');
    const oldRevision = (await domain.revisions(ORG, PROJECT))!.revision;

    // Observe the store at every write the domain makes during an edit and a
    // delete: whenever the new revision is visible, the new value must be too.
    const seen: Array<{ revision: string | undefined; runtime: Record<string, string> }> = [];
    const original = ops.updateAtomic.bind(ops);
    const deleteMany = ops.deleteMany.bind(ops);
    const observe = async () => {
      const revisions = await domain.revisions(ORG, PROJECT);
      seen.push({ revision: revisions?.revision, runtime: (await domain.resolve(ORG, PROJECT)).runtime });
    };
    ops.updateAtomic = (async (...args: Parameters<typeof ops.updateAtomic>) => {
      const result = await original(...args);
      await observe();
      return result;
    }) as typeof ops.updateAtomic;
    ops.deleteMany = (async (...args: Parameters<typeof ops.deleteMany>) => {
      const result = await deleteMany(...args);
      await observe();
      return result;
    }) as typeof ops.deleteMany;

    await domain.set(ORG, PROJECT, { name: 'R', value: 'new', appliesTo: 'runtime' }, 'u');
    const editRevision = (await domain.revisions(ORG, PROJECT))!.revision;
    await domain.delete(ORG, PROJECT, 'R');
    ops.updateAtomic = original;
    ops.deleteMany = deleteMany;

    expect(seen.length).toBeGreaterThanOrEqual(4);
    // A revision may lag the rows (the next write is already in), never lead them.
    for (const state of seen) {
      if (state.revision === oldRevision) continue;
      if (state.revision === editRevision) expect([{ R: 'new' }, {}]).toContainEqual(state.runtime);
      else expect(state.runtime).toEqual({});
    }
    expect(seen.some(state => state.revision === oldRevision && state.runtime.R === 'new')).toBe(true);
  });

  it('migrates variables stored before stages to development', async () => {
    const url = `file:${join(mkdtempSync(join(tmpdir(), 'factory-envs-stage-')), 'envs.db')}`;
    // The table as it was before the stage column existed.
    const { stage: _stage, ...columns } = SANDBOX_ENVS_SCHEMA.columns;
    const legacySchema: CollectionSchema = { ...SANDBOX_ENVS_SCHEMA, columns };
    class LegacySandboxEnvs extends FactoryStorageDomain {
      constructor() {
        super('sandbox-envs');
      }
      async init() {
        await this.ensureCollections([legacySchema]);
      }
      async dangerouslyClearAll() {}
      insert(row: Record<string, unknown>) {
        return this.ops.insertOne('factory_sandbox_envs', row);
      }
    }
    const legacy = new LibSQLFactoryStorage({ id: 'sandbox-envs-legacy', url });
    const legacyDomain = legacy.registerDomain(new LegacySandboxEnvs());
    await legacy.init();
    const now = new Date();
    await legacyDomain.insert({
      org_id: ORG,
      project_id: PROJECT,
      name: 'OLD',
      value: 'kept',
      applies_to: 'both',
      created_by: 'u',
      updated_by: 'u',
      created_at: now,
      updated_at: now,
    });
    await legacy.close();

    const backend = new LibSQLFactoryStorage({ id: 'sandbox-envs-migrated', url });
    const domain = backend.registerDomain(new SandboxEnvsStorage());
    await backend.init();
    onTestFinished(() => backend.close());
    expect(await domain.list(ORG, PROJECT)).toEqual([expect.objectContaining({ name: 'OLD', stage: 'development' })]);
    expect(await domain.resolve(ORG, PROJECT)).toMatchObject({ runtime: { OLD: 'kept' }, build: { OLD: 'kept' } });
  });

  it('gives sandboxes development variables only until staging is enabled, and never production', async () => {
    const { domain } = await makeStore();
    expect(await domain.stages(ORG, PROJECT)).toEqual(['development']);
    await domain.set(ORG, PROJECT, { name: 'DEV', value: 'd', appliesTo: 'both' }, 'u');
    await domain.set(ORG, PROJECT, { name: 'STAGE', value: 's', appliesTo: 'both', stage: 'staging' }, 'u');
    await domain.set(ORG, PROJECT, { name: 'PROD', value: 'p', appliesTo: 'both', stage: 'production' }, 'u');

    expect(await domain.resolve(ORG, PROJECT)).toMatchObject({ runtime: { DEV: 'd' }, build: { DEV: 'd' } });

    const before = (await domain.revisions(ORG, PROJECT))!;
    expect(await domain.setStages(ORG, PROJECT, ['development', 'staging'], 'admin')).toEqual([
      'development',
      'staging',
    ]);
    const after = (await domain.revisions(ORG, PROJECT))!;
    expect(after.revision).not.toBe(before.revision);
    expect(after.buildRevision).not.toBe(before.buildRevision);
    expect(await domain.resolve(ORG, PROJECT)).toMatchObject({
      runtime: { DEV: 'd', STAGE: 's' },
      build: { DEV: 'd', STAGE: 's' },
      stages: ['development', 'staging'],
    });

    // Production is dropped even when a caller asks for it.
    await domain.setStages(ORG, PROJECT, ['development', 'staging', 'production' as 'staging'], 'admin');
    expect(await domain.stages(ORG, PROJECT)).toEqual(['development', 'staging']);
    expect((await domain.resolve(ORG, PROJECT)).runtime).not.toHaveProperty('PROD');

    // An unchanged set leaves the revision alone.
    const unchanged = (await domain.revisions(ORG, PROJECT))!;
    await domain.setStages(ORG, PROJECT, ['staging', 'development'], 'admin');
    expect(await domain.revisions(ORG, PROJECT)).toEqual(unchanged);
  });

  it("changes a variable's stage, keeping its stage when a value is replaced", async () => {
    const { domain } = await makeStore();
    await domain.set(ORG, PROJECT, { name: 'R', value: '1', appliesTo: 'runtime', stage: 'staging' }, 'u');
    await domain.set(ORG, PROJECT, { name: 'R', value: '2', appliesTo: 'runtime' }, 'u');
    expect(await domain.list(ORG, PROJECT)).toEqual([expect.objectContaining({ stage: 'staging' })]);

    const before = (await domain.revisions(ORG, PROJECT))!;
    await domain.update(ORG, PROJECT, 'R', { stage: 'development' }, 'u');
    const after = (await domain.revisions(ORG, PROJECT))!;
    expect(after.revision).not.toBe(before.revision);
    // A runtime-only variable never moves the build revision.
    expect(after.buildRevision).toBe(before.buildRevision);
    expect((await domain.resolve(ORG, PROJECT)).runtime).toEqual({ R: '2' });
  });

  it('stores env files encrypted, lists metadata only and resolves enabled stages', async () => {
    const { ops, domain } = await makeStore();
    const dev = await domain.createFile(
      ORG,
      PROJECT,
      { projectRepositoryId: 'link-1', path: '.env.development', stage: 'development', content: 'API=sentinel-dev\n' },
      'admin',
    );
    await domain.createFile(
      ORG,
      PROJECT,
      { projectRepositoryId: 'link-1', path: '.env.staging', stage: 'staging', content: 'API=sentinel-stage\n' },
      'admin',
    );
    await domain.createFile(
      ORG,
      PROJECT,
      { projectRepositoryId: 'link-1', path: '.env.production', stage: 'production', content: 'API=sentinel-prod\n' },
      'admin',
    );

    const rows = await ops.findMany<{ content: string }>('factory_sandbox_env_files', {});
    for (const row of rows) {
      expect(row.content.startsWith('mastra:factory-secret:v1:')).toBe(true);
      expect(row.content).not.toContain('sentinel');
    }
    const listed = await domain.listFiles(ORG, PROJECT);
    expect(listed.map(file => [file.path, file.stage, file.size])).toEqual([
      ['.env.development', 'development', 17],
      ['.env.production', 'production', 18],
      ['.env.staging', 'staging', 19],
    ]);
    expect(JSON.stringify(listed)).not.toContain('sentinel');
    expect((await domain.getFile(ORG, PROJECT, dev.id))?.content).toBe('API=sentinel-dev\n');
    expect(await domain.getFile('org-2', PROJECT, dev.id)).toBeNull();

    expect((await domain.resolve(ORG, PROJECT)).files.map(file => file.path)).toEqual(['.env.development']);
    await domain.setStages(ORG, PROJECT, ['development', 'staging'], 'admin');
    const resolved = await domain.resolve(ORG, PROJECT);
    expect(resolved.files).toEqual([
      expect.objectContaining({ projectRepositoryId: 'link-1', path: '.env.development', content: 'API=sentinel-dev\n' }),
      expect.objectContaining({ path: '.env.staging', stage: 'staging', content: 'API=sentinel-stage\n' }),
    ]);
  });

  it('bumps the revision on every env file write, never the build revision', async () => {
    const { domain } = await makeStore();
    await domain.set(ORG, PROJECT, { name: 'B', value: '1', appliesTo: 'build' }, 'u');
    const input = { projectRepositoryId: 'link-1', path: 'apps/mobile/.env', stage: 'development' as const, content: 'A=1' };
    let before = (await domain.revisions(ORG, PROJECT))!;
    let fileId = '';
    for (const write of [
      async () => (fileId = (await domain.createFile(ORG, PROJECT, input, 'u')).id),
      () => domain.updateFile(ORG, PROJECT, fileId, { content: 'A=2' }, 'u'),
      () => domain.updateFile(ORG, PROJECT, fileId, { stage: 'staging', path: 'apps/mobile/.env.staging' }, 'u'),
      () => domain.deleteFile(ORG, PROJECT, fileId),
    ]) {
      await write();
      const current = (await domain.revisions(ORG, PROJECT))!;
      expect(current.revision).not.toBe(before.revision);
      expect(current.buildRevision).toBe(before.buildRevision);
      before = current;
    }
    expect(await domain.listFiles(ORG, PROJECT)).toEqual([]);
    expect(await domain.deleteFile(ORG, PROJECT, fileId)).toBe(false);
    expect(await domain.updateFile(ORG, PROJECT, fileId, { content: 'x' }, 'u')).toBeNull();
  });

  it('refuses a second file at the same path of a repository and invalid paths', async () => {
    const { domain } = await makeStore();
    const input = { projectRepositoryId: 'link-1', path: '.env', stage: 'development' as const, content: '' };
    await domain.createFile(ORG, PROJECT, input, 'u');
    await expect(domain.createFile(ORG, PROJECT, { ...input, stage: 'staging' }, 'u')).rejects.toBeInstanceOf(
      SandboxEnvFilePathTakenError,
    );
    // Another repository may use the same path.
    await domain.createFile(ORG, PROJECT, { ...input, projectRepositoryId: 'link-2' }, 'u');
    await expect(domain.createFile(ORG, PROJECT, { ...input, path: '../.env' }, 'u')).rejects.toThrow(/leave/);
  });
});

describe('sandboxEnvFilePathProblem', () => {
  it.each(['.env', '.env.staging', 'apps/mobile/.env', 'ios/Config.xcconfig', 'android/app/google-services.json'])(
    'accepts %s',
    path => expect(sandboxEnvFilePathProblem(path)).toBeUndefined(),
  );
  it.each([
    ['', /Enter/],
    ['/etc/passwd', /relative/],
    ['~/.env', /relative/],
    ['C:/x/.env', /relative/],
    ['../.env', /leave/],
    ['apps/../../.env', /leave/],
    ['.git/config', /\.git/],
    ['sub/.GIT/hooks/pre-commit', /\.git/],
    ['apps//.env', /empty/],
    ['./.env', /empty/],
    ['apps/.env/', /empty/],
    ['my env', /letters/],
    ['.env*', /letters/],
    ['a\nb', /letters/],
    ['x'.repeat(257), /256/],
  ])('refuses %j', (path, problem) => expect(sandboxEnvFilePathProblem(path)).toMatch(problem));
});
