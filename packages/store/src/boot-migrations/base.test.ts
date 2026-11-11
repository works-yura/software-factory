import { describe, expect, it } from 'vitest';

import { createFactoryStorageForTests } from '../testing.ts';

describe('BootMigrationsStorage', () => {
  it('records a finished migration once, whichever replica writes first', async () => {
    const { bootMigrations } = await createFactoryStorageForTests();

    expect(await bootMigrations.completed()).toEqual(new Set());
    await Promise.all([bootMigrations.markCompleted('intake.labelRoutes.v1'), bootMigrations.markCompleted('intake.labelRoutes.v1')]);
    await bootMigrations.markCompleted('boards.productPhases.v1');

    expect(await bootMigrations.completed()).toEqual(new Set(['intake.labelRoutes.v1', 'boards.productPhases.v1']));
  });
});
