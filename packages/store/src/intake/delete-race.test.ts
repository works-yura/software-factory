import { randomUUID } from 'node:crypto';

import { PgFactoryStorage } from '@mastra/pg';
import { describe, expect, it, vi } from 'vitest';

import { FactoryProjectsStorage } from '../projects/base.ts';
import { FactoryProjectNotFoundError, IntakeStorage } from './base.ts';

const postgresUrl = process.env.FACTORY_TEST_POSTGRES_URL;

/** `Promise.withResolvers`, which this package's TypeScript lib predates. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

describe.skipIf(!postgresUrl)(
  'a factory deleted while a binding to it is mid-write on independent PostgreSQL clients',
  () => {
    it('refuses the binding and leaves no routing behind', async () => {
      const orgId = `org-${randomUUID()}`;
      const backends = ['deleter', 'binder'].map(id => new PgFactoryStorage({ id, connectionString: postgresUrl! }));
      const resume = deferred();
      let outcome: Promise<unknown> | undefined;
      try {
        const [deleter, binder] = backends.map(storage => ({
          projects: storage.registerDomain(new FactoryProjectsStorage()),
          intake: storage.registerDomain(new IntakeStorage()),
        }));
        for (const storage of backends) await storage.init();
        const project = await deleter!.projects.create({
          orgId,
          userId: 'user-1',
          input: { name: 'Deleted mid-bind' },
        });
        const prototype = Object.getPrototypeOf(backends[0]!.ops) as { updateMany: (...args: unknown[]) => unknown };
        const original = prototype.updateMany;
        const reachedWrite = deferred();
        let holding = true;
        vi.spyOn(prototype, 'updateMany').mockImplementation(async function (this: unknown, ...args: unknown[]) {
          if (args[0] === 'intake_source_bindings' && holding) {
            holding = false;
            reachedWrite.resolve();
            await resume.promise;
          }
          return original.apply(this, args);
        });

        outcome = binder!.intake
          .setBinding({
            orgId,
            integrationId: 'github',
            sourceId: 'acme/api',
            factoryProjectId: project.id,
          })
          .then(
            () => undefined,
            (error: unknown) => error,
          );
        await reachedWrite.promise;
        await deleter!.projects.delete({ orgId, id: project.id }, ops =>
          deleter!.intake.clearProjectBindings({ orgId, factoryProjectId: project.id }, ops),
        );
        resume.resolve();

        expect(await outcome).toBeInstanceOf(FactoryProjectNotFoundError);
        expect(await backends[0]!.ops.findMany('intake_source_bindings', { org_id: orgId })).toEqual([]);
      } finally {
        resume.resolve();
        await outcome;
        vi.restoreAllMocks();
        try {
          await backends[0]!.ops.deleteMany('intake_source_bindings', { org_id: orgId });
          await backends[0]!.ops.deleteMany('factory_projects', { org_id: orgId });
        } finally {
          await Promise.all(backends.map(storage => storage.close()));
        }
      }
    });
  },
);
