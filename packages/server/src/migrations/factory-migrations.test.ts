import { describe, expect, it, vi } from 'vitest';

import { EXISTING_ORGANIZATION_ID } from '@factory/auth';
import type { FactoryIntegration } from '@factory/integrations';

import { factoryBootMigrations } from './factory-migrations.ts';
import type { FactoryMigrationDeps } from './factory-migrations.ts';
import { runBootMigrations } from './run.ts';

function migrationsWith(integrations: FactoryIntegration[], retiredIntegrationEnv: Record<string, string>) {
  const handles = new Map<string, { integrationId: string }>();
  const deps = {
    ready: () => true,
    integrations,
    retiredIntegrationEnv,
    integrationStorage: {
      forIntegration: (id: string) => {
        if (!handles.has(id)) handles.set(id, { integrationId: id });
        return handles.get(id);
      },
    },
  } as unknown as FactoryMigrationDeps;
  return { migrations: factoryBootMigrations(deps).filter(migration => migration.id.startsWith('integrations.envTokensToOrg.')), handles };
}

function memoryMarkers() {
  const done = new Set<string>();
  return { done, completed: async () => new Set(done), markCompleted: async (id: string) => void done.add(id) };
}

describe('integrations.envTokensToOrg boot migration', () => {
  it("hands each integration that takes a deployment token the retired env, for the organization that owned the data", async () => {
    const adoptDeploymentToken = vi.fn(async () => 'moved CLICKUP_API_TOKEN');
    const clickup = { id: 'clickup', routes: () => [], diagnostics: () => ({}), adoptDeploymentToken } as FactoryIntegration;
    const firebase = { id: 'firebase', routes: () => [], diagnostics: () => ({}) } as FactoryIntegration;
    const { migrations, handles } = migrationsWith([clickup, firebase], { CLICKUP_API_TOKEN: 'pk_env' });
    expect(migrations.map(migration => [migration.id, migration.onFailure, migration.integrationId])).toEqual([
      ['integrations.envTokensToOrg.clickup.v1', 'disable-integration', 'clickup'],
    ]);
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const markers = memoryMarkers();
    expect((await runBootMigrations(migrations, { markers })).ran).toEqual(['integrations.envTokensToOrg.clickup.v1']);
    expect(adoptDeploymentToken).toHaveBeenCalledWith({
      storage: handles.get('clickup'),
      orgId: EXISTING_ORGANIZATION_ID,
      env: { CLICKUP_API_TOKEN: 'pk_env' },
    });
    expect(info).toHaveBeenCalledWith('[factory] moved CLICKUP_API_TOKEN');
    // Once done, later boots never read the env again.
    expect((await runBootMigrations(migrations, { markers })).ran).toEqual([]);
    expect(adoptDeploymentToken).toHaveBeenCalledTimes(1);
    info.mockRestore();
  });

  it('turns only that integration off when the move fails, and retries at the next boot', async () => {
    const adoptDeploymentToken = vi.fn().mockRejectedValueOnce(new Error('storage down')).mockResolvedValueOnce(undefined);
    const clickup = { id: 'clickup', routes: () => [], diagnostics: () => ({}), adoptDeploymentToken } as unknown as FactoryIntegration;
    const { migrations } = migrationsWith([clickup], { CLICKUP_API_TOKEN: 'pk_env' });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const markers = memoryMarkers();
    expect((await runBootMigrations(migrations, { markers })).disabledIntegrations).toEqual(new Set(['clickup']));
    expect(markers.done.size).toBe(0);
    expect((await runBootMigrations(migrations, { markers })).ran).toEqual(['integrations.envTokensToOrg.clickup.v1']);
    error.mockRestore();
  });
});

describe('runBindings.restoreAgeRevoked boot migration', () => {
  function restoreMigration(restore: ReturnType<typeof vi.fn>, projectBoards: unknown = {}) {
    const deps = {
      ready: () => true,
      integrations: [],
      retiredIntegrationEnv: {},
      projectBoards,
      workItems: { restoreAgeRevokedRunBindings: restore },
    } as unknown as FactoryMigrationDeps;
    return factoryBootMigrations(deps).filter(migration => migration.id === 'runBindings.restoreAgeRevoked.v1');
  }
  const binding = (id: string) => ({ id, workItemId: `card-${id}`, role: 'product', sessionId: `session-${id}` });

  it('logs what it restored and what it left revoked, and runs once', async () => {
    const restore = vi.fn(async () => ({
      restored: [binding('a')],
      skipped: [{ binding: binding('b'), reason: 'its session is bound to another card' }],
    }));
    const migrations = restoreMigration(restore);
    expect(migrations.map(migration => [migration.ready, migration.onFailure])).toEqual([[true, 'warn']]);
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const markers = memoryMarkers();

    expect((await runBootMigrations(migrations, { markers })).ran).toEqual(['runBindings.restoreAgeRevoked.v1']);
    expect(restore).toHaveBeenCalledWith({ minAgeMs: 24 * 60 * 60_000, now: expect.any(Date) });
    expect(info).toHaveBeenCalledWith(
      '[factory] restored 1 run binding(s) the stale-binding sweep revoked by age: a (card card-a, product seat, session session-a)',
    );
    expect(warn).toHaveBeenCalledWith(
      '[factory] left binding b revoked (card card-b, product seat, session session-b): its session is bound to another card',
    );
    expect((await runBootMigrations(migrations, { markers })).ran).toEqual([]);
    info.mockRestore();
    warn.mockRestore();
  });

  it('waits for the project boards, so a finished card is known as finished', () => {
    expect(restoreMigration(vi.fn(), null).map(migration => migration.ready)).toEqual([false]);
  });
});
