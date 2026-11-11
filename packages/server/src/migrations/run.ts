/**
 * One-off data migrations that run at boot, in one ordered list. Each has a stable, versioned id
 * and a stored marker once it finished, so later boots skip it. A marker only saves work: every
 * migration stays idempotent, so replicas booting together may each run it and the second marker
 * insert is a no-op. Changing what a migration does means a new id (`….v2`), never editing a
 * finished one in place.
 */

export type BootMigrationFailure =
  /** Serving on half-migrated data would be wrong: the boot stops. */
  | 'stop-boot'
  /** Worth a warning, nothing depends on it: the boot goes on and the next boot retries. */
  | 'warn'
  /** Only one integration depends on it: that integration is off for this boot, the next retries. */
  | 'disable-integration';

export interface BootMigration {
  /** Stable, versioned id, e.g. `intake.labelRoutes.v1`. */
  id: string;
  /** Whether the storage it touches is up on this boot; a migration that isn't ready is retried next boot. */
  ready: boolean;
  onFailure: BootMigrationFailure;
  /** The integration a `disable-integration` failure turns off. */
  integrationId?: string;
  /** Does the work; returns a line for the log when it changed something. */
  run(): Promise<string | undefined>;
}

export interface BootMigrationMarkers {
  completed(): Promise<Set<string>>;
  markCompleted(migrationId: string): Promise<void>;
}

export interface BootMigrationsResult {
  /** Integrations whose migration failed on this boot. */
  disabledIntegrations: Set<string>;
  /** Ids that ran (were not already marked done). */
  ran: string[];
}

export async function runBootMigrations(
  migrations: readonly BootMigration[],
  {
    markers,
    timed = (_label, fn) => fn(),
  }: {
    /** Absent when the markers domain isn't up: every ready migration then runs (each is idempotent). */
    markers?: BootMigrationMarkers;
    timed?: <T>(label: string, fn: () => Promise<T>) => Promise<T>;
  },
): Promise<BootMigrationsResult> {
  const ids = new Set<string>();
  for (const migration of migrations) {
    if (ids.has(migration.id)) throw new Error(`Boot migration id "${migration.id}" is used twice.`);
    if (migration.onFailure === 'disable-integration' && !migration.integrationId) {
      throw new Error(`Boot migration "${migration.id}" disables an integration but names none.`);
    }
    ids.add(migration.id);
  }
  if (!markers) {
    console.warn('[factory] boot migration markers are unavailable: every ready migration runs this boot');
  }
  const done = markers ? await markers.completed() : new Set<string>();
  const result: BootMigrationsResult = { disabledIntegrations: new Set(), ran: [] };
  for (const migration of migrations) {
    if (!migration.ready || done.has(migration.id)) continue;
    try {
      const line = await timed(`prepare.migrate.${migration.id}`, () => migration.run());
      if (line) console.info(`[factory] ${line}`);
      await markers?.markCompleted(migration.id);
      result.ran.push(migration.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (migration.onFailure === 'stop-boot') {
        throw new Error(`Boot migration "${migration.id}" failed: ${message}`, { cause: error });
      }
      if (migration.onFailure === 'disable-integration') {
        result.disabledIntegrations.add(migration.integrationId!);
        console.error(
          `[factory] integration "${migration.integrationId}" is disabled: its migration failed (it runs again at the next boot) [${migration.id}]: ${message}`,
        );
        continue;
      }
      console.warn(`[factory] boot migration "${migration.id}" failed (it runs again at the next boot): ${message}`);
    }
  }
  return result;
}
