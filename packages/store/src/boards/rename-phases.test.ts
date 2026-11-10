import { randomUUID } from 'node:crypto';

import { LibSQLFactoryStorage } from '@mastra/libsql';
import { describe, expect, it, onTestFinished } from 'vitest';

import { createIsolatedFactoryPostgresForTests } from '../testing.ts';
import { PRODUCT_BOARD_UPGRADE_ACTOR, StoredBoardsStorage } from './base.ts';
import type { StoredBoardInput, StoredBoardScope } from './base.ts';

const postgresUrl = process.env.FACTORY_TEST_POSTGRES_URL;
const RENAMES = { breakdown: 'phases', 'breakdown-review': 'phases-review' };

const OLD: StoredBoardInput = {
  key: 'product',
  name: 'Product',
  phases: [
    { key: 'intake', name: 'Intake', kind: 'resting', nextPhases: ['spec', 'canceled'] },
    {
      key: 'spec',
      name: 'Spec',
      kind: 'working',
      runner: { skill: 'product-spec', context: 'product', instructions: 'Docs live in acme/docs, docs/.' },
      nextPhases: ['breakdown', 'canceled'],
    },
    {
      key: 'breakdown',
      name: 'Breakdown',
      kind: 'working',
      runner: { skill: 'product-breakdown', context: 'product', instructions: 'Server is acme/api.' },
      autoStart: true,
      nextPhases: ['breakdown-review', 'canceled'],
    },
    { key: 'breakdown-review', name: 'Breakdown review', kind: 'resting', nextPhases: ['breakdown', 'done'] },
    { key: 'done', name: 'Done', kind: 'terminal' },
    { key: 'canceled', name: 'Canceled', kind: 'terminal', nextPhases: ['intake'] },
  ],
};

const NEW: StoredBoardInput = {
  key: 'product',
  name: 'Product',
  phases: [
    { key: 'intake', name: 'Intake', kind: 'resting', nextPhases: ['enrich', 'spec', 'canceled'] },
    {
      key: 'enrich',
      name: 'Research',
      kind: 'working',
      runner: { skill: 'product-enrich', context: 'product' },
      nextPhases: ['spec', 'canceled'],
    },
    {
      key: 'spec',
      name: 'Spec',
      kind: 'working',
      runner: { skill: 'product-spec', context: 'product' },
      nextPhases: ['phases', 'canceled'],
    },
    {
      key: 'phases',
      name: 'Phases',
      kind: 'working',
      runner: { skill: 'product-phases', context: 'product' },
      nextPhases: ['phases-review', 'canceled'],
    },
    { key: 'phases-review', name: 'Phases review', kind: 'resting', nextPhases: ['phases', 'done', 'canceled'] },
    { key: 'done', name: 'Done', kind: 'terminal' },
    { key: 'canceled', name: 'Canceled', kind: 'terminal', nextPhases: ['intake'] },
  ],
};

describe.each(['libsql', ...(postgresUrl ? ['postgres'] : [])])('renaming stored board phases on %s', backend => {
  async function setup() {
    const storage =
      backend === 'postgres'
        ? await createIsolatedFactoryPostgresForTests(postgresUrl!)
        : new LibSQLFactoryStorage({ id: `rename-phases-${randomUUID()}`, url: ':memory:' });
    const boards = storage.registerDomain(new StoredBoardsStorage());
    await storage.init();
    onTestFinished(() => storage.close());
    const scope: StoredBoardScope = { orgId: `org-${randomUUID()}`, factoryProjectId: 'project-1' };
    return { boards, scope };
  }

  it("rewrites a stored board that names an old phase to the new definition, keeping each phase's settings", async () => {
    const { boards, scope } = await setup();
    const stored = await boards.create(scope, OLD, 'admin');
    const route = await boards.createIntakeRoute(
      scope,
      { name: 'Specs to breakdown', target: { boardKey: 'product', phaseKey: 'breakdown' } },
      'admin',
    );
    const versionBefore = await boards.readVersion(scope);

    expect(await boards.renameStoredBoardPhases('product', NEW, RENAMES, PRODUCT_BOARD_UPGRADE_ACTOR)).toBe(1);

    const after = (await boards.get(scope, 'product'))!;
    expect(after.phases.map(phase => phase.key)).toEqual(NEW.phases.map(phase => phase.key));
    expect(after.revision).toBe(stored.revision + 1);
    expect(after.updatedBy).toBe(PRODUCT_BOARD_UPGRADE_ACTOR);
    const phase = (key: string) => after.phases.find(candidate => candidate.key === key)!;
    // What the Factory set on a phase follows it to its new name, or stays where the key stayed.
    expect(phase('phases').runner).toMatchObject({ skill: 'product-phases', instructions: 'Server is acme/api.' });
    expect(phase('phases').autoStart).toBe(true);
    expect(phase('spec').runner).toMatchObject({ skill: 'product-spec', instructions: 'Docs live in acme/docs, docs/.' });
    expect(phase('enrich').runner?.instructions).toBeUndefined();
    expect(await boards.readVersion(scope)).not.toBe(versionBefore);
    expect((await boards.getIntakeRoute(scope, route.id))?.target).toEqual({ boardKey: 'product', phaseKey: 'phases' });

    // Once: the board no longer names an old phase.
    expect(await boards.renameStoredBoardPhases('product', NEW, RENAMES, PRODUCT_BOARD_UPGRADE_ACTOR)).toBe(0);
    expect((await boards.get(scope, 'product'))!.revision).toBe(after.revision);
  });

  it('leaves a board already on the new phases alone', async () => {
    const { boards, scope } = await setup();
    const stored = await boards.create(scope, NEW, 'admin');
    expect(await boards.renameStoredBoardPhases('product', NEW, RENAMES, PRODUCT_BOARD_UPGRADE_ACTOR)).toBe(0);
    expect((await boards.get(scope, 'product'))!.revision).toBe(stored.revision);
  });
});
