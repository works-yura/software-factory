import type { CredentialProvider } from '@factory/capabilities';
import type { IntegrationStorageHandle } from '@factory/store';

import { UNBOUND_ACCOUNT, readAccountKey, readFirebaseState } from './settings.ts';

/**
 * The organization's Google Cloud accounts (Settings › Logs and crashes) lent to other parts of
 * the Factory by reference: an MCP server picks one instead of pasting its key again. The key
 * leaves only through `readSecret`, for the launcher.
 */
export function googleCloudAccountProvider(storage: Pick<IntegrationStorageHandle, 'connections' | 'settings'>): CredentialProvider {
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
  };
}
