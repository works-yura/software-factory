/**
 * Test seam for suites exercising the factory storage domains: registers the built-in domains on a
 * fresh libsql `:memory:` `FactoryStorage` (or an isolated Postgres schema) and returns the typed
 * domain handles. Copied from v3 `storage/test-utils.ts`; the board registry is a parameter here
 * because this package does not know Work and Review.
 */

import { randomUUID } from 'node:crypto';

import type { FactoryStorage } from '@mastra/core/storage';
import { LibSQLFactoryStorage } from '@mastra/libsql';
import type { PgFactoryStorage } from '@mastra/pg';
import { onTestFinished } from 'vitest';

import { createBoardRegistry, workItemPhaseSemantics } from '@factory/core';
import type { BoardRegistry } from '@factory/core';
import { AuditStorage } from './audit/base.ts';
import { StoredBoardsStorage } from './boards/base.ts';
import { ChannelIdentityStorage } from './channel-identity/base.ts';
import { WorkItemCommentsStorage } from './comments/base.ts';
import { ModelCredentialsStorage } from './credentials/base.ts';
import { CustomProvidersStorage } from './custom-providers/base.ts';
import { IntakeStorage } from './intake/base.ts';
import { IntegrationStorage } from './integrations/base.ts';
import { MemorySettingsStorage } from './memory-settings/base.ts';
import { ModelDefaultsStorage } from './model-defaults/base.ts';
import { FactoryProjectsStorage } from './projects/base.ts';
import { QueueHealthStorage } from './queue-health/base.ts';
import { SkillOverridesStorage } from './skill-overrides/base.ts';
import { SourceControlStorage } from './source-control/base.ts';
import { WorkItemsStorage } from './work-items/base.ts';

/** Keep migration tests from clearing tables another Postgres test is using. */
export async function createIsolatedFactoryPostgresForTests(connectionString: string): Promise<PgFactoryStorage> {
  const { PgFactoryStorage, PostgresStore } = await import('@mastra/pg');
  const admin = new PostgresStore({ id: 'factory-test-admin', connectionString, disableInit: true });
  const schema = `factory_test_${randomUUID().replaceAll('-', '')}`;
  await admin.pool.query(`CREATE SCHEMA "${schema}"`);
  const url = new URL(connectionString);
  url.searchParams.set('options', `-c search_path=${schema}`);
  onTestFinished(async () => {
    await admin.pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.close();
  });
  return new PgFactoryStorage({ id: 'factory-test', connectionString: url.toString() });
}

export interface FactoryStorageTestSeed<T extends FactoryStorage = FactoryStorage> {
  storage: T;
  intake: IntakeStorage;
  audit: AuditStorage;
  workItems: WorkItemsStorage;
  credentials: ModelCredentialsStorage;
  integrations: IntegrationStorage;
  projects: FactoryProjectsStorage;
  sourceControl: SourceControlStorage;
  modelDefaults: ModelDefaultsStorage;
  memorySettings: MemorySettingsStorage;
  customProviders: CustomProvidersStorage;
  queueHealth: QueueHealthStorage;
  channelIdentity: ChannelIdentityStorage;
  comments: WorkItemCommentsStorage;
  /** The projects' stored boards (named apart from the `boards` registries tests spread beside the seed). */
  storedBoards: StoredBoardsStorage;
  skillOverrides: SkillOverridesStorage;
}

/**
 * Create fresh storage with every built-in domain. Defaults to LibSQL `:memory:`;
 * `FACTORY_TEST_STORAGE_BACKEND=postgres` uses an isolated schema at `FACTORY_TEST_POSTGRES_URL`.
 * The backend closes automatically when the current test finishes.
 */
export async function createFactoryStorageForTests<T extends FactoryStorage = FactoryStorage>(
  options: { boards?: BoardRegistry; storage?: T } = {},
): Promise<FactoryStorageTestSeed<T>> {
  let storage: FactoryStorage | undefined = options.storage;
  if (!storage && process.env.FACTORY_TEST_STORAGE_BACKEND === 'postgres') {
    const url = process.env.FACTORY_TEST_POSTGRES_URL;
    if (!url) throw new Error('FACTORY_TEST_POSTGRES_URL is required for the Postgres test backend.');
    storage = await createIsolatedFactoryPostgresForTests(url);
  }
  storage ??= new LibSQLFactoryStorage({ id: 'factory-test', url: ':memory:' });
  const intake = storage.registerDomain(new IntakeStorage());
  const audit = storage.registerDomain(new AuditStorage());
  const workItems = storage.registerDomain(new WorkItemsStorage());
  const boardRegistry = options.boards ?? createBoardRegistry();
  workItems.useTerminalPhasePredicate(item => workItemPhaseSemantics(boardRegistry, item)?.kind === 'terminal');
  const credentials = storage.registerDomain(new ModelCredentialsStorage());
  const integrations = storage.registerDomain(new IntegrationStorage());
  const projects = storage.registerDomain(new FactoryProjectsStorage());
  const sourceControl = storage.registerDomain(new SourceControlStorage());
  const modelDefaults = storage.registerDomain(new ModelDefaultsStorage());
  const memorySettings = storage.registerDomain(new MemorySettingsStorage());
  const customProviders = storage.registerDomain(new CustomProvidersStorage());
  const queueHealth = storage.registerDomain(new QueueHealthStorage());
  const channelIdentity = storage.registerDomain(new ChannelIdentityStorage());
  const comments = storage.registerDomain(new WorkItemCommentsStorage());
  const storedBoards = storage.registerDomain(new StoredBoardsStorage());
  const skillOverrides = storage.registerDomain(new SkillOverridesStorage());
  await storage.init();
  onTestFinished(() => storage.close());
  return {
    storage: storage as T,
    intake,
    audit,
    workItems,
    credentials,
    integrations,
    projects,
    sourceControl,
    modelDefaults,
    memorySettings,
    customProviders,
    queueHealth,
    channelIdentity,
    comments,
    storedBoards,
    skillOverrides,
  };
}
