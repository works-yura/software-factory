import type { ApiRoute } from '@mastra/core/server';
import { LibSQLFactoryStorage } from '@mastra/libsql';
import type { Hono } from 'hono';

import { onTestFinished } from 'vitest';
import { IntakeStorage } from '@factory/store';
import { IntegrationStorage } from '@factory/store';
import { FactoryProjectsStorage } from '@factory/store';
import { SourceControlStorage } from '@factory/store';
import { WorkItemsStorage } from '@factory/store';

export async function createPlatformStorageForTests() {
  const storage = new LibSQLFactoryStorage({ id: 'platform-integration-test', url: ':memory:' });
  const intake = storage.registerDomain(new IntakeStorage());
  const integrations = storage.registerDomain(new IntegrationStorage());
  const projects = storage.registerDomain(new FactoryProjectsStorage());
  const sourceControl = storage.registerDomain(new SourceControlStorage());
  const workItems = storage.registerDomain(new WorkItemsStorage());
  await storage.init();
  onTestFinished(() => storage.close());
  return { storage, intake, integrations, projects, sourceControl, workItems };
}

export function mountApiRoutes(app: Hono, routes: ApiRoute[]): void {
  for (const route of routes) {
    if ('handler' in route) app.on(route.method, route.path, route.handler as never);
  }
}

export { describeConnectorContract } from './connector-contract.ts';
export type { ConnectorContractFixture } from './connector-contract.ts';
