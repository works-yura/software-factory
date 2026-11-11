import { FactoryStorageDomain, UniqueViolationError } from '@mastra/core/storage';
import type { CollectionSchema } from '@mastra/core/storage';

/**
 * Which one-off boot migrations have finished, one row per migration id. A marker only skips work
 * already done: every migration stays idempotent, so two replicas booting at once may both run one,
 * and the second marker insert loses the unique race harmlessly.
 */
export const BOOT_MIGRATIONS_SCHEMA: CollectionSchema = {
  name: 'factory_boot_migrations',
  columns: {
    id: { type: 'uuid-pk' },
    migration_id: { type: 'text' },
    completed_at: { type: 'timestamp' },
  },
  uniqueIndexes: [{ name: 'factory_boot_migrations_migration_key', columns: ['migration_id'] }],
};

interface BootMigrationRow extends Record<string, unknown> {
  id: string;
  migration_id: string;
  completed_at: Date;
}

export class BootMigrationsStorage extends FactoryStorageDomain {
  constructor() {
    super('boot-migrations');
  }

  async init(): Promise<void> {
    await this.ensureCollections([BOOT_MIGRATIONS_SCHEMA]);
  }

  async dangerouslyClearAll(): Promise<void> {
    await this.ops.deleteMany('factory_boot_migrations', {});
  }

  /** The ids of every finished migration. */
  async completed(): Promise<Set<string>> {
    const rows = await this.ops.findMany<BootMigrationRow>('factory_boot_migrations', {});
    return new Set(rows.map(row => row.migration_id));
  }

  /** Records `migrationId` as finished; a marker another replica wrote first counts as written. */
  async markCompleted(migrationId: string, at: Date = new Date()): Promise<void> {
    try {
      await this.ops.insertOne<BootMigrationRow>('factory_boot_migrations', {
        migration_id: migrationId,
        completed_at: at,
      });
    } catch (error) {
      if (!(error instanceof UniqueViolationError)) throw error;
    }
  }
}
