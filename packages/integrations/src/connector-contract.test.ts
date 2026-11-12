// The conformance kit on a fake connector the registry knows nothing about: what every real
// connector's contract test runs (`describeConnectorContract`).
import { connectionOk, connectionRefused } from './connections.ts';
import type { ConnectorConnection, IntegrationConnections } from './connections.ts';
import { describeConnectorContract } from './connector-contract.ts';

const SECRET = 'acme_live_secret_123456';

function acme(): IntegrationConnections {
  const rows = new Map<string, { name: string; key: string }>([['main', { name: 'Main', key: SECRET }]]);
  const flows = new Map<string, 'pending' | 'completed'>();
  const view = (id: string, language: 'en' | 'uk'): ConnectorConnection => ({
    id,
    label: rows.get(id)!.name,
    status: 'active',
    displayName: rows.get(id)!.name,
    accountLabel: 'acme-team',
    provides: [{ key: 'tasks', label: language === 'uk' ? 'Тікети' : 'Tickets' }],
    state: { tone: 'ok', label: language === 'uk' ? 'Підключено' : 'Connected' },
    scope: 'organization',
    actions: { rename: true, remove: true },
  });
  return {
    describe: request => ({
      name: 'Acme Cloud',
      icon: 'acme',
      description: request.language === 'uk' ? 'Тікети з Acme.' : 'Tickets from Acme.',
      category: 'sources',
      provides: [{ key: 'tasks', label: request.language === 'uk' ? 'Тікети' : 'Tickets' }],
      capabilities: { multipleConnectionsPerToolkit: true, batchConnectionStatus: false, reauthorizeReusesConnectionId: true },
      methods: [
        { id: 'key', label: request.language === 'uk' ? 'Ключ API' : 'API key', authKind: 'apiKey', fields: [{ name: 'key', displayName: 'Key', type: 'secret', required: true }], available: true },
        { id: 'sso', label: 'Acme SSO', authKind: 'oauth', available: true },
      ],
    }),
    list: async request => [...rows.keys()].map(id => view(id, request.language)),
    connect: async (request, method, input) => {
      if (method === 'sso') {
        const authId = `flow-${flows.size + 1}`;
        flows.set(authId, 'pending');
        return connectionOk({ type: 'authorize', url: 'https://acme.example/authorize', authId });
      }
      if (!input.key) return connectionRefused(422, { error: 'invalid', message: 'Key needed', fields: { key: 'Key needed' } });
      rows.set('second', { name: 'Second', key: input.key });
      return connectionOk({ type: 'connected', connection: view('second', request.language), title: 'Acme connected' });
    },
    getAuthStatus: async (_request, authId) => flows.get(authId) ?? null,
    rename: async (_request, id, name) => {
      rows.get(id)!.name = name;
      return connectionOk({ name });
    },
    removalImpact: async (_request, id) =>
      rows.has(id)
        ? { title: 'Remove?', body: 'Routes stop.', dependents: [{ label: 'Shop' }], items: [{ label: 'Intake', outcome: 'stops', outcomeLabel: 'Stops' }], confirmLabel: 'Remove', cancelLabel: 'Cancel', requiresConfirm: true }
        : null,
    remove: async (_request, id, { confirm }) => {
      if (!confirm) return connectionRefused(409, { error: 'confirm', message: 'Confirm', impact: { title: 'Remove?', body: '', dependents: [], items: [], confirmLabel: 'Remove', cancelLabel: 'Cancel', requiresConfirm: true } });
      rows.delete(id);
      return connectionOk({ message: 'Removed' });
    },
    detail: async () => [{ type: 'facts', rows: [{ label: 'Team', value: 'acme-team' }] }],
    // Test hook: the provider finishes a flow.
    ...({ finish: (authId: string) => flows.set(authId, 'completed') } as object),
  };
}

describeConnectorContract('Acme Cloud (fake)', async () => {
  const connections = acme();
  return {
    registration: { id: 'acme', connections },
    orgId: 'org-1',
    admin: 'admin',
    member: 'member',
    secrets: [SECRET],
    expectsConnections: true,
    connect: { method: 'key', input: { key: 'acme_other' } },
    authorize: { method: 'sso', finish: async authId => void (connections as unknown as { finish(id: string): void }).finish(authId) },
    rename: 'acme:main',
    remove: 'acme:main',
  };
});
