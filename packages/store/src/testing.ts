/**
 * Test seam for suites exercising the factory storage domains without a real
 * Postgres: registers the built-in domains on a fresh libsql `:memory:`
 * `FactoryStorage` and returns the typed domain handles. Copied from v3
 * `storage/test-utils.ts`; the board registry is a parameter here because this
 * package does not know Work and Review.
 */

import { LibSQLFactoryStorage } from '@mastra/libsql';
import { onTestFinished } from 'vitest';

import { createBoardRegistry, workItemPhaseSemantics } from '@factory/core';
import type { BoardRegistry } from '@factory/core';
import { AuditStorage } from './audit/base.ts';
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
import { SourceControlStorage } from './source-control/base.ts';
import { WorkItemsStorage } from './work-items/base.ts';

export interface FactoryStorageTestSeed {
  storage: LibSQLFactoryStorage;
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
}

/**
 * Create a fresh libsql `:memory:` `FactoryStorage` with every built-in domain
 * registered. Call per test (state is per-instance). The backend closes
 * automatically when the current test finishes.
 */
export async function createFactoryStorageForTests(
  options: { boards?: BoardRegistry } = {},
): Promise<FactoryStorageTestSeed> {
  const storage = new LibSQLFactoryStorage({ id: 'factory-test', url: ':memory:' });
  const intake = storage.registerDomain(new IntakeStorage());
  const audit = storage.registerDomain(new AuditStorage());
  const workItems = storage.registerDomain(new WorkItemsStorage());
  const boards = options.boards ?? createBoardRegistry();
  workItems.useTerminalPhasePredicate(item => workItemPhaseSemantics(boards, item)?.kind === 'terminal');
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
  await storage.init();
  onTestFinished(() => storage.close());
  return {
    storage,
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
  };
}
