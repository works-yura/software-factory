import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LibSQLFactoryStorage } from '@mastra/libsql';
import { describe, expect, it, onTestFinished } from 'vitest';

import { FactoryProjectsStorage } from '../projects/base.ts';
import { DEFAULT_INTAKE_CONFIG, FactoryProjectNotFoundError, IntakeStorage } from './base.ts';
import { seedLegacyLabelRoute } from './label-routes.test-support.ts';

/** `projectIdsByOrg`: Factory projects to create, since a binding needs its project to exist. */
async function makeStorage(
  url: string = ':memory:',
  projectIdsByOrg: Record<string, string[]> = {},
): Promise<IntakeStorage> {
  const backend = new LibSQLFactoryStorage({ id: 'intake-test', url });
  backend.registerDomain(new FactoryProjectsStorage());
  const domain = backend.registerDomain(new IntakeStorage());
  await backend.init();
  onTestFinished(() => backend.close());
  const now = new Date();
  for (const [orgId, ids] of Object.entries(projectIdsByOrg)) {
    for (const id of ids) {
      await backend.ops.insertOne('factory_projects', {
        id,
        org_id: orgId,
        created_by: 'user1',
        name: id,
        created_at: now,
        updated_at: now,
      });
    }
  }
  return domain;
}

describe('IntakeStorage', () => {
  it('returns a fresh empty config for every caller', async () => {
    const storage = await makeStorage();
    const first = await storage.getConfig({ orgId: 'org1' });
    first.github = { enabled: false, sourceIds: null };
    const second = await storage.getConfig({ orgId: 'org1' });

    expect(second).toEqual(DEFAULT_INTAKE_CONFIG);
    expect(second).not.toBe(DEFAULT_INTAKE_CONFIG);
  });

  it('round-trips dynamic integration selections per org', async () => {
    const storage = await makeStorage();
    const config = {
      github: { enabled: true, sourceIds: ['repo-1'] },
      gitlab: { enabled: false, sourceIds: null },
    };

    await storage.saveConfig({ orgId: 'org1', config });
    expect(await storage.getConfig({ orgId: 'org1' })).toEqual(config);
    expect(await storage.getConfig({ orgId: 'org2' })).toEqual(DEFAULT_INTAKE_CONFIG);

    const updated = { ...config, gitlab: { enabled: true, sourceIds: ['team-1'] } };
    await storage.saveConfig({ orgId: 'org1', config: updated });
    expect(await storage.getConfig({ orgId: 'org1' })).toEqual(updated);
  });

  it('converges concurrent first saves onto one row', async () => {
    const storage = await makeStorage();
    const a = { github: { enabled: true, sourceIds: ['a'] } };
    const b = { gitlab: { enabled: true, sourceIds: ['b'] } };

    await Promise.all([
      storage.saveConfig({ orgId: 'org1', config: a }),
      storage.saveConfig({ orgId: 'org1', config: b }),
    ]);

    expect([a, b]).toContainEqual(await storage.getConfig({ orgId: 'org1' }));
  });

  describe('legacy per-member selections', () => {
    // File-backed so a per-member deployment can write rows, close, and a later boot folds them.
    function tempDatabaseUrl(): string {
      const dir = mkdtempSync(join(tmpdir(), 'intake-fold-'));
      onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
      return `file:${join(dir, 'intake.db')}`;
    }

    async function seedLegacyRows(url: string, rows: Array<{ orgId: string; userId: string; config: unknown }>) {
      const backend = new LibSQLFactoryStorage({ id: 'intake-test-legacy', url });
      backend.registerDomain(new IntakeStorage());
      await backend.init();
      const now = new Date();
      try {
        for (const row of rows) {
          await backend.ops.insertOne('intake_settings', {
            org_id: row.orgId,
            user_id: row.userId,
            config: row.config,
            created_at: now,
            updated_at: now,
          });
        }
      } finally {
        await backend.close();
      }
    }

    it('folds what members were syncing into one shared selection at boot, ignoring switched-off picks', async () => {
      const url = tempDatabaseUrl();
      await seedLegacyRows(url, [
        { orgId: 'org1', userId: 'alice', config: { github: { enabled: true, sourceIds: ['acme/app'] } } },
        {
          orgId: 'org1',
          userId: 'bob',
          config: {
            github: { enabled: false, sourceIds: ['acme/site'] },
            gitlab: { enabled: true, sourceIds: ['proj-1'] },
          },
        },
        { orgId: 'org2', userId: 'alice', config: { github: { enabled: false, sourceIds: null } } },
      ]);

      const storage = await makeStorage(url);

      expect(await storage.getConfig({ orgId: 'org1' })).toEqual({
        github: { enabled: true, sourceIds: ['acme/app'] },
        gitlab: { enabled: true, sourceIds: ['proj-1'] },
      });
      expect(await storage.getConfig({ orgId: 'org2' })).toEqual({ github: { enabled: false, sourceIds: null } });
    });

    it('does not overwrite a shared selection saved after the fold', async () => {
      const url = tempDatabaseUrl();
      await seedLegacyRows(url, [
        { orgId: 'org1', userId: 'alice', config: { github: { enabled: true, sourceIds: ['acme/app'] } } },
      ]);

      const firstBoot = await makeStorage(url);
      const shared = { github: { enabled: false, sourceIds: null } };
      await firstBoot.saveConfig({ orgId: 'org1', config: shared });

      const secondBoot = await makeStorage(url);
      expect(await secondBoot.getConfig({ orgId: 'org1' })).toEqual(shared);
    });
  });

  describe('source bindings', () => {
    it('scopes bound source ids to one org and Factory project', async () => {
      const storage = await makeStorage(undefined, { org1: ['proj-1', 'proj-2'], org2: ['proj-9'] });
      await storage.setBinding({
        orgId: 'org1',
        integrationId: 'gitlab',
        sourceId: 'src-a',
        factoryProjectId: 'proj-1',
        userId: 'user1',
      });
      await storage.setBinding({
        orgId: 'org1',
        integrationId: 'gitlab',
        sourceId: 'src-b',
        factoryProjectId: 'proj-2',
      });
      await storage.setBinding({
        orgId: 'org2',
        integrationId: 'gitlab',
        sourceId: 'src-c',
        factoryProjectId: 'proj-9',
      });

      const scope = { orgId: 'org1', integrationId: 'gitlab' };
      expect(await storage.listBoundSourceIds({ ...scope, factoryProjectId: 'proj-1' })).toEqual(['src-a']);
      expect(await storage.listBoundSourceIds({ ...scope, factoryProjectId: 'proj-2' })).toEqual(['src-b']);
      expect(await storage.listBoundSourceIds({ ...scope, factoryProjectId: 'proj-3' })).toEqual([]);
      expect(await storage.listBindings({ orgId: 'org1' })).toHaveLength(2);
      expect(await storage.listBindings({ orgId: 'org1', integrationId: 'github' })).toEqual([]);
    });

    it('moves a source to another project instead of binding it twice', async () => {
      const storage = await makeStorage(undefined, { org1: ['proj-1', 'proj-2'] });
      const binding = { orgId: 'org1', integrationId: 'gitlab', sourceId: 'src-a' };

      await storage.setBinding({ ...binding, factoryProjectId: 'proj-1' });
      await storage.setBinding({ ...binding, factoryProjectId: 'proj-2' });

      expect(await storage.listBindings({ orgId: 'org1' })).toEqual([
        { integrationId: 'gitlab', sourceId: 'src-a', factoryProjectId: 'proj-2', board: null },
      ]);
      expect(await storage.listBoundSourceIds({ ...binding, factoryProjectId: 'proj-1' })).toEqual([]);
    });

    it('persists the bound board and resets it when rebound without one', async () => {
      const storage = await makeStorage(undefined, { org1: ['proj-1', 'proj-2'] });
      const binding = { orgId: 'org1', integrationId: 'gitlab', sourceId: 'src-a' };

      await storage.setBinding({ ...binding, factoryProjectId: 'proj-1', board: 'release' });
      expect(await storage.getBinding(binding)).toEqual({
        integrationId: 'gitlab',
        sourceId: 'src-a',
        factoryProjectId: 'proj-1',
        board: 'release',
      });

      await storage.setBinding({ ...binding, factoryProjectId: 'proj-1' });
      expect((await storage.getBinding(binding))?.board).toBeNull();
      expect(await storage.getBinding({ ...binding, sourceId: 'missing' })).toBeNull();
    });

    it('clears a binding and returns its project', async () => {
      const storage = await makeStorage(undefined, { org1: ['proj-1', 'proj-2'] });
      const binding = { orgId: 'org1', integrationId: 'gitlab', sourceId: 'src-a' };

      await storage.setBinding({ ...binding, factoryProjectId: 'proj-1' });
      expect(await storage.clearBinding(binding)).toEqual({
        integrationId: 'gitlab',
        sourceId: 'src-a',
        factoryProjectId: 'proj-1',
        board: null,
      });

      expect(await storage.clearBinding(binding)).toBeNull();
      expect(await storage.listBindings({ orgId: 'org1' })).toEqual([]);
    });

    it('refuses a binding to a Factory project that does not exist', async () => {
      const storage = await makeStorage(undefined, { org1: ['proj-1'] });
      const binding = { orgId: 'org1', integrationId: 'gitlab', sourceId: 'src-a' };

      await expect(storage.setBinding({ ...binding, factoryProjectId: 'gone' })).rejects.toBeInstanceOf(
        FactoryProjectNotFoundError,
      );
      // A project of another org does not count either.
      await expect(
        storage.setBinding({ ...binding, orgId: 'org2', factoryProjectId: 'proj-1' }),
      ).rejects.toBeInstanceOf(FactoryProjectNotFoundError);
      expect(await storage.listBindings({ orgId: 'org1', integrationId: 'gitlab' })).toEqual([]);
    });

    it("releases every source of one Factory project and leaves the others' bindings", async () => {
      const storage = await makeStorage(undefined, { org1: ['proj-1', 'proj-2'] });
      const scope = { orgId: 'org1', integrationId: 'gitlab' };
      await storage.setBinding({ ...scope, sourceId: 'src-a', factoryProjectId: 'proj-1' });
      await storage.setBinding({ ...scope, sourceId: 'src-b', factoryProjectId: 'proj-1' });
      await storage.setBinding({ ...scope, sourceId: 'src-c', factoryProjectId: 'proj-2' });

      await storage.clearProjectBindings({ orgId: 'org1', factoryProjectId: 'proj-1' });

      expect(await storage.listBoundSourceIds({ ...scope, factoryProjectId: 'proj-1' })).toEqual([]);
      expect(await storage.listBoundSourceIds({ ...scope, factoryProjectId: 'proj-2' })).toEqual(['src-c']);
    });

    it('converges concurrent first bindings onto one row', async () => {
      const storage = await makeStorage(undefined, { org1: ['proj-1', 'proj-2'] });
      const binding = { orgId: 'org1', integrationId: 'gitlab', sourceId: 'src-a' };

      await Promise.all([
        storage.setBinding({ ...binding, factoryProjectId: 'proj-1' }),
        storage.setBinding({ ...binding, factoryProjectId: 'proj-2' }),
      ]);

      const rows = await storage.listBindings({ orgId: 'org1' });
      expect(rows).toHaveLength(1);
      expect(['proj-1', 'proj-2']).toContain(rows[0]!.factoryProjectId);
    });

    it('atomically migrates and deduplicates equivalent source selections and bindings', async () => {
      const storage = await makeStorage(undefined, { org1: ['proj-1', 'proj-2'] });
      await storage.saveConfig({
        orgId: 'org1',
        config: { gitlab: { enabled: true, sourceIds: ['legacy-a', 'legacy-b', 'canonical'] } },
      });
      for (const sourceId of ['legacy-a', 'legacy-b']) {
        await storage.setBinding({
          orgId: 'org1',
          integrationId: 'gitlab',
          sourceId,
          factoryProjectId: 'proj-1',
          board: 'work',
        });
      }

      await expect(
        storage.migrateSourceIds({
          orgId: 'org1',
          integrationId: 'gitlab',
          migrations: [
            { from: 'legacy-a', to: 'canonical' },
            { from: 'legacy-b', to: 'canonical' },
          ],
        }),
      ).resolves.toMatchObject({ conflicts: [] });
      expect(await storage.getConfig({ orgId: 'org1' })).toEqual({
        gitlab: { enabled: true, sourceIds: ['canonical'] },
      });
      expect(await storage.listBindings({ orgId: 'org1', integrationId: 'gitlab' })).toEqual([
        { integrationId: 'gitlab', sourceId: 'canonical', factoryProjectId: 'proj-1', board: 'work' },
      ]);
    });

    it('rejects conflicting canonical routes without changing selection or bindings', async () => {
      const storage = await makeStorage(undefined, { org1: ['proj-1', 'proj-2'] });
      const config = { gitlab: { enabled: true, sourceIds: ['legacy', 'canonical'] } };
      await storage.saveConfig({ orgId: 'org1', config });
      await storage.setBinding({
        orgId: 'org1',
        integrationId: 'gitlab',
        sourceId: 'legacy',
        factoryProjectId: 'proj-1',
        board: 'work',
      });
      await storage.setBinding({
        orgId: 'org1',
        integrationId: 'gitlab',
        sourceId: 'canonical',
        factoryProjectId: 'proj-2',
        board: 'review',
      });

      await expect(
        storage.migrateSourceIds({
          orgId: 'org1',
          integrationId: 'gitlab',
          migrations: [{ from: 'legacy', to: 'canonical' }],
        }),
      ).resolves.toEqual({ migrations: [], conflicts: [{ from: 'legacy', to: 'canonical' }] });
      expect(await storage.getConfig({ orgId: 'org1' })).toEqual(config);
      expect(await storage.listBindings({ orgId: 'org1', integrationId: 'gitlab' })).toHaveLength(2);
    });
  });

  it('moves sources and label routes off the retired Review board onto Work, once', async () => {
    const url = `file:${join(tmpdir(), `intake-review-${randomUUID()}.db`)}`;
    const storage = await makeStorage(url, { org1: ['proj-1'] });
    // A second handle on the same database, to write the old label rows nothing in the app writes now.
    const backend = new LibSQLFactoryStorage({ id: 'intake-review-seed', url });
    backend.registerDomain(new IntakeStorage());
    await backend.init();
    onTestFinished(() => backend.close());
    await storage.setBinding({
      orgId: 'org1',
      integrationId: 'github',
      sourceId: 'acme/api',
      factoryProjectId: 'proj-1',
      board: 'review',
    });
    await storage.setBinding({
      orgId: 'org1',
      integrationId: 'gitlab',
      sourceId: 'acme/web',
      factoryProjectId: 'proj-1',
      board: 'release',
    });
    const route = { orgId: 'org1', factoryProjectId: 'proj-1', integrationId: 'github' };
    await seedLegacyLabelRoute(backend.ops, { ...route, label: 'needs-review', board: 'review' });
    await seedLegacyLabelRoute(backend.ops, { ...route, label: 'release', board: 'release' });

    expect(await storage.moveReviewBoardSourcesToWork()).toEqual({ bindings: 1, labelRoutes: 1 });

    expect(await storage.listBindings({ orgId: 'org1' })).toEqual(
      expect.arrayContaining([
        { integrationId: 'github', sourceId: 'acme/api', factoryProjectId: 'proj-1', board: 'work' },
        { integrationId: 'gitlab', sourceId: 'acme/web', factoryProjectId: 'proj-1', board: 'release' },
      ]),
    );
    expect(
      (await storage.listLabelRoutesForIntegration('github')).sort((a, b) => a.label.localeCompare(b.label)),
    ).toEqual([
      { orgId: 'org1', factoryProjectId: 'proj-1', integrationId: 'github', label: 'needs-review', board: 'work' },
      { orgId: 'org1', factoryProjectId: 'proj-1', integrationId: 'github', label: 'release', board: 'release' },
    ]);
    expect(await storage.moveReviewBoardSourcesToWork()).toEqual({ bindings: 0, labelRoutes: 0 });
  });
});
