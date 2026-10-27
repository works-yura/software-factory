/**
 * Test seam for suites exercising the storage domains without a real Postgres:
 * registers the domains on a fresh libsql `:memory:` `FactoryStorage` and
 * returns the typed handles. Cut from v3 `storage/test-utils.ts` down to the
 * domains this package owns.
 */

import { createBoardRegistry, workItemPhaseSemantics } from '@factory/core';
import type { BoardRegistry } from '@factory/core';
import { LibSQLFactoryStorage } from '@mastra/libsql';
import { onTestFinished } from 'vitest';

import { AuditStorage } from './audit/base.ts';
import { WorkItemCommentsStorage } from './comments/base.ts';
import { WorkItemsStorage } from './work-items/base.ts';

export interface FactoryStorageTestSeed {
  storage: LibSQLFactoryStorage;
  audit: AuditStorage;
  workItems: WorkItemsStorage;
  comments: WorkItemCommentsStorage;
}

/**
 * Create a fresh libsql `:memory:` `FactoryStorage`. Call per test (state is
 * per-instance). The backend closes automatically when the current test finishes.
 * `boards` decides which phases count as terminal; v3 passed its built-in Work
 * and Review here, which this package does not know about.
 */
export async function createFactoryStorageForTests(
  options: { boards?: BoardRegistry } = {},
): Promise<FactoryStorageTestSeed> {
  const storage = new LibSQLFactoryStorage({ id: 'factory-test', url: ':memory:' });
  const audit = storage.registerDomain(new AuditStorage());
  const workItems = storage.registerDomain(new WorkItemsStorage());
  const boards = options.boards ?? createBoardRegistry();
  workItems.useTerminalPhasePredicate(item => workItemPhaseSemantics(boards, item)?.kind === 'terminal');
  const comments = storage.registerDomain(new WorkItemCommentsStorage());
  await storage.init();
  onTestFinished(() => storage.close());
  return { storage, audit, workItems, comments };
}
