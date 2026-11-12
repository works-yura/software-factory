/**
 * A minimal third-party connector package (ADR-0037): "Notes Cloud", connected with an API key kept in
 * memory. Load it with `FACTORY_CONNECTOR_PACKAGES=<path to this file>`; the conformance kit runs
 * against it (`src/connector-packages.test.ts`). Everything it shows is its own copy in en and uk;
 * permissions are declared, never checked here.
 */
import { connectionOk, connectionRefused, localize } from '../../src/connections.ts';
import type { ConnectionCopy, ConnectorConnection, IntegrationConnections } from '../../src/connections.ts';
import type { ConnectorPackage } from '../../src/connector-packages.ts';

const COPY: ConnectionCopy<{ description: string; key: string; keyHelp: string; notes: string; connected: string; removed: string; invalid: string; impactTitle: (name: string) => string; impactBody: string; remove: string; cancel: string }> = {
  en: {
    description: 'Notes agents can read and write.',
    key: 'API key',
    keyHelp: 'From Notes Cloud › Settings › API.',
    notes: 'Notes',
    connected: 'Connected',
    removed: 'Removed.',
    invalid: 'The key starts with notes_.',
    impactTitle: name => `Remove ${name}?`,
    impactBody: 'Agents stop reading these notes.',
    remove: 'Remove',
    cancel: 'Cancel',
  },
  uk: {
    description: 'Нотатки, які агенти читають і пишуть.',
    key: 'API-ключ',
    keyHelp: 'З Notes Cloud › Налаштування › API.',
    notes: 'Нотатки',
    connected: 'Підключено',
    removed: 'Видалено.',
    invalid: 'Ключ починається з notes_.',
    impactTitle: name => `Видалити ${name}?`,
    impactBody: 'Агенти перестануть читати ці нотатки.',
    remove: 'Видалити',
    cancel: 'Скасувати',
  },
};

export function createNotesConnections(): IntegrationConnections {
  // The organization's accounts, by id; the key never leaves this map.
  const accounts = new Map<string, { orgId: string; name: string; key: string }>();
  const view = (id: string, language: 'en' | 'uk'): ConnectorConnection => {
    const copy = localize(COPY, language);
    const account = accounts.get(id)!;
    return {
      id,
      label: account.name,
      status: 'active',
      displayName: account.name,
      accountLabel: `…${account.key.slice(-4)}`,
      provides: [{ key: 'tools', label: copy.notes }],
      state: { tone: 'ok', label: copy.connected },
      scope: 'organization',
      actions: { rename: true, remove: true },
    };
  };
  return {
    describe: request => {
      const copy = localize(COPY, request.language);
      return {
        name: 'Notes Cloud',
        icon: 'notes-cloud',
        description: copy.description,
        category: 'tools',
        provides: [{ key: 'tools', label: copy.notes }],
        capabilities: { multipleConnectionsPerToolkit: true, batchConnectionStatus: false, reauthorizeReusesConnectionId: false, supportsRevoke: false },
        methods: [{ id: 'key', label: copy.key, authKind: 'apiKey', fields: [{ name: 'key', displayName: copy.key, description: copy.keyHelp, type: 'secret', required: true }], available: true }],
      };
    },
    list: async request => [...accounts.entries()].filter(([, account]) => account.orgId === request.orgId).map(([id]) => view(id, request.language)),
    connect: async (request, method, input) => {
      const copy = localize(COPY, request.language);
      if (method !== 'key' || !input.key?.startsWith('notes_')) return connectionRefused(422, { error: 'invalid_key', message: copy.invalid, fields: { key: copy.invalid } });
      const id = `n${accounts.size + 1}`;
      accounts.set(id, { orgId: request.orgId, name: `Notes ${accounts.size + 1}`, key: input.key });
      return connectionOk({ type: 'connected', connection: view(id, request.language), title: copy.connected });
    },
    rename: async (_request, id, name) => {
      const account = accounts.get(id);
      if (!account) return connectionRefused(404, { error: 'not_found', message: 'Not found' });
      account.name = name || account.name;
      return connectionOk({ name: account.name });
    },
    removalImpact: async (request, id) => {
      const account = accounts.get(id);
      if (!account) return null;
      const copy = localize(COPY, request.language);
      return { title: copy.impactTitle(account.name), body: copy.impactBody, dependents: [], items: [], confirmLabel: copy.remove, cancelLabel: copy.cancel, requiresConfirm: false };
    },
    remove: async (request, id) => {
      accounts.delete(id);
      return connectionOk({ message: localize(COPY, request.language).removed });
    },
  };
}

export const connector: ConnectorPackage = {
  id: 'notes-cloud',
  contractVersion: '1.2.0',
  create: () => createNotesConnections(),
};
