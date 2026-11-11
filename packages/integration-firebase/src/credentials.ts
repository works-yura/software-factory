import type { CredentialProvider } from '@factory/capabilities';
import type { IntegrationStorageHandle } from '@factory/store';

import { listFirestoreDatabases, listGoogleCloudProjects } from './discovery.ts';
import type { FetchLike } from './service-account.ts';
import { UNBOUND_ACCOUNT, readAccountKey, readFirebaseState } from './settings.ts';

/**
 * The organization's Google Cloud accounts (Settings › Integrations › Google Cloud) lent to other parts of
 * the Factory by reference: an MCP server picks one instead of pasting its key again. The key
 * leaves only through `readSecret`, for the launcher; `discover` looks up the account's projects and
 * a project's Firestore databases with it, returning names only.
 */
export function googleCloudAccountProvider(
  storage: Pick<IntegrationStorageHandle, 'connections' | 'settings'>,
  options: { fetch?: FetchLike } = {},
): CredentialProvider {
  const discoveryOptions = options.fetch ? { fetch: options.fetch } : {};
  return {
    kind: 'google-cloud-account',
    async list(orgId) {
      const { accounts } = await readFirebaseState(storage, orgId);
      return accounts.map(account => ({ id: account.id, name: account.name, detail: account.clientEmail }));
    },
    async readSecret(orgId, id) {
      const key = await readAccountKey(storage, orgId, id);
      return key ? JSON.stringify(key) : null;
    },
    async suggest(orgId, factoryProjectId) {
      const { bindings } = await readFirebaseState(storage, orgId);
      const binding = bindings.find(candidate => candidate.factoryProjectId === factoryProjectId && candidate.accountId !== UNBOUND_ACCOUNT);
      return binding ? { 'google-cloud-project': binding.projectId } : {};
    },
    async discover(orgId, accountId, source, context) {
      const key = await readAccountKey(storage, orgId, accountId);
      if (!key) return { items: [], denied: { message: 'This Google Cloud account no longer exists.' } };
      if (source === 'google-cloud-projects') return listGoogleCloudProjects(key, discoveryOptions);
      const project = context.project?.trim() || key.project_id;
      return listFirestoreDatabases(key, project, discoveryOptions);
    },
  };
}
