/**
 * Google Cloud's «База»: a binding with the database switched on gets MCP Toolbox for its project's
 * Firestore, run as an MCP server this integration manages. Settings › Інтеграції › MCP lists it as
 * «керує Google Cloud»; people change only what its tools may do there.
 */

import type { ManagedMcpServerSpec } from '@factory/core';

import { UNBOUND_ACCOUNT, readsDatabase } from './settings.ts';
import type { FirebaseBinding } from './settings.ts';

/** The MCP Toolbox catalog entry and its Firestore way of running (packages/server mcp-servers/catalog). */
const TOOLBOX_ENTRY = 'mcp-toolbox';
const FIRESTORE_VARIANT = 'firestore';

const DEFAULT_DATABASE = '(default)';

/** A server name the MCP store accepts (`[a-z][a-z0-9-]{1,30}`), derived from the project. */
function serverName(projectId: string): string {
  return `db-${projectId}`.slice(0, 31).replace(/-+$/, '');
}

/** The servers the bindings ask for: one per binding with «База» on and an account to read through. */
export function managedDatabaseServers(bindings: readonly FirebaseBinding[]): ManagedMcpServerSpec[] {
  return bindings
    .filter(binding => readsDatabase(binding) && binding.accountId !== UNBOUND_ACCOUNT)
    .map(binding => {
      const databaseId = binding.database?.databaseId;
      const named = databaseId && databaseId !== DEFAULT_DATABASE ? databaseId : undefined;
      return {
        key: binding.id,
        name: serverName(binding.projectId),
        label: named ? `Firestore ${binding.projectId} · ${named}` : `Firestore ${binding.projectId}`,
        launch: {
          transport: 'catalog',
          entry: TOOLBOX_ENTRY,
          variant: FIRESTORE_VARIANT,
          inputs: { FIRESTORE_PROJECT: binding.projectId, ...(named ? { FIRESTORE_DATABASE: named } : {}) },
          credentials: { GOOGLE_APPLICATION_CREDENTIALS: { kind: 'google-cloud-account', id: binding.accountId } },
        },
        assignments: [{ factoryProjectId: binding.factoryProjectId }],
      } satisfies ManagedMcpServerSpec;
    });
}
