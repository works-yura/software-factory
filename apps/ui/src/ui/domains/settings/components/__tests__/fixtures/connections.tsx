import { Toaster } from '@mastra/playground-ui/components/Toaster';
import { http, HttpResponse } from 'msw';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';

import { server } from '../../../../../../../e2e/ui/msw-server';
import { renderWithProviders, TEST_BASE_URL } from '../../../../../../../e2e/ui/render';
import type { ConnectionsListResponse, ConnectionView, ConnectorView } from '@factory/contracts';

import type { FirebaseState } from '../../../services/firebase';
import type { McpServer } from '../../../services/mcpServers';
import { ConnectionsPageHeader } from '../../connections/ConnectionsPageHeader';
import { ConnectionsSection } from '../../connections/ConnectionsSection';

export const FACTORY_ID = 'factory-1';
export const MCP_BASE = `${TEST_BASE_URL}/web/mcp-servers`;

export const firebaseState: FirebaseState = {
  accounts: [
    { id: 'acc-1', name: 'Syncta', clientEmail: 'factory@syncta-57c6a.iam.gserviceaccount.com', projectId: 'syncta-57c6a', keyId: 'k', bindingIds: ['bnd-1'] },
  ],
  bindings: [
    { id: 'bnd-1', factoryProjectId: FACTORY_ID, accountId: 'acc-1', projectId: 'syncta-57c6a', logs: true, crashes: false, apps: [], database: { enabled: true } },
  ],
};

/** Google Cloud's «База» for `bnd-1`, as the server lists it. */
export const managedServer: McpServer = {
  id: 'srv-gc',
  name: 'db-syncta-57c6a',
  label: 'Firestore syncta-57c6a',
  owner: { integration: 'firebase', key: 'bnd-1' },
  launch: { transport: 'catalog', entry: 'mcp-toolbox', variant: 'firestore', inputs: { FIRESTORE_PROJECT: 'syncta-57c6a' },
    credentials: { GOOGLE_APPLICATION_CREDENTIALS: { kind: 'google-cloud-account', id: 'acc-1' } },
  },
  secretNames: { env: [], headers: [], files: [] },
  assignments: [{ factoryProjectId: FACTORY_ID }],
  toolPolicies: { default: 'allow', tools: {} },
  maskPersonalData: true,
  enabled: true,
  health: { state: 'ok', tools: [{ name: 'list_collections', description: '' }] },
  updatedAt: '2026-11-12T00:00:00.000Z',
  updatedBy: 'integration:firebase',
};

/**
 * A connector the UI has never heard of. Two ways in: an API key form, and a sign-in redirect the
 * server says is unavailable here. Proves the page holds no provider knowledge.
 */
export const acmeConnector: ConnectorView = {
  id: 'acme',
  name: 'Acme Cloud',
  icon: 'acme',
  description: 'Tickets from Acme projects.',
  category: 'sources',
  provides: [{ key: 'tasks', label: 'Tickets' }],
  capabilities: { multipleConnectionsPerToolkit: true, batchConnectionStatus: false, reauthorizeReusesConnectionId: true },
  methods: [
    {
      id: 'key',
      label: 'API key',
      description: 'A key from Acme’s settings.',
      authKind: 'apiKey',
      fields: [{ name: 'key', displayName: 'Acme API key', type: 'secret', description: 'Starts with acme_.', required: true }],
      submitLabel: 'Connect Acme',
      available: true,
    },
    { id: 'sso', label: 'Sign in with Acme', authKind: 'oauth', available: { reason: 'Acme sign-in is off on this server.' } },
  ],
};

export const acmeConnection: ConnectionView = {
  id: 'acme:main',
  connector: { id: 'acme', name: 'Acme Cloud', icon: 'acme' },
  label: 'Acme main',
  status: 'active',
  displayName: 'Acme main',
  accountLabel: 'acme-team',
  accountDetail: 'Team',
  method: 'API key',
  provides: [{ key: 'tasks', label: 'Tickets' }],
  state: { tone: 'ok', label: 'Live' },
  scope: 'organization',
  createdAt: '2026-11-01T10:00:00.000Z',
  dependents: 'Used by 2 Factories',
  actions: {
    rename: true,
    reconnect: { method: { ...acmeConnector.methods[0]!, submitLabel: 'Replace key' } },
    remove: true,
    manageExternally: { reason: 'Acme has no console for keys.' },
  },
};

/**
 * The integrations' state around the MCP servers a test brings: one Google Cloud binding (or
 * none), GitLab not set up, one connection of a FAKE server connector (Acme Cloud —
 * the page must render it from the server's descriptors alone), no activity.
 */
export function useIntegrationHandlers(
  options: { firebase?: FirebaseState; connections?: ConnectionsListResponse; connectors?: ConnectorView[] } = {},
) {
  server.use(
    http.get(`${TEST_BASE_URL}/web/factory/projects`, () =>
      HttpResponse.json({ projects: [{ id: FACTORY_ID, name: 'syncts', repositories: [] }] }),
    ),
    http.get(`${TEST_BASE_URL}/web/firebase/status`, () => HttpResponse.json(options.firebase ?? { accounts: [], bindings: [] })),
    http.get(`${TEST_BASE_URL}/web/clickup/status`, () =>
      HttpResponse.json({ configured: true, connected: true, workspaces: ['eclipt.ai'], intervalSeconds: 60 }),
    ),
    http.get(`${TEST_BASE_URL}/web/intake/config`, () =>
      HttpResponse.json({ config: { github: { enabled: false, sourceIds: null }, gitlab: { enabled: false, sourceIds: null }, clickup: { enabled: true, sourceIds: null } } }),
    ),
    http.get(`${TEST_BASE_URL}/web/connections`, () => HttpResponse.json(options.connections ?? { connections: [acmeConnection], failures: [], copy: { organizationWide: 'Whole organization' } })),
    http.get(`${TEST_BASE_URL}/web/connections/:id/detail`, () => HttpResponse.json({ sections: [] })),
    http.get(`${TEST_BASE_URL}/web/connections/methods`, () => HttpResponse.json({ connectors: options.connectors ?? [acmeConnector] })),
    http.get(`${TEST_BASE_URL}/web/gitlab/status`, () => HttpResponse.json({ enabled: false, configured: false, reauthRequired: false, reason: 'missing_config' })),
    http.get(`${TEST_BASE_URL}/web/firebase/accounts/:accountId/projects`, () => HttpResponse.json({ items: [{ value: 'syncta-57c6a' }] })),
    http.get(`${TEST_BASE_URL}/web/firebase/accounts/:accountId/databases`, () => HttpResponse.json({ items: [{ value: '(default)' }] })),
    http.get(`${MCP_BASE}/activity`, () => HttpResponse.json({ since: '2026-11-11T12:00:00.000Z', total: 0, errors: 0, calls: [], truncated: false })),
  );
}

/** The URL's query, for tests that check what a click put there. */
function Search() {
  return <span data-testid="search">{useLocation().search}</span>;
}

/** Settings › Підключення of `factory-1`, at `search` (`?connection=…` opens one). */
export function renderConnections(search = '') {
  return renderWithProviders(
    <MemoryRouter initialEntries={[`/factories/${FACTORY_ID}/settings/integrations${search}`]}>
      <Routes>
        <Route
          path="/factories/:factoryId/settings/integrations"
          element={
            <>
              <ConnectionsPageHeader />
              <ConnectionsSection />
              <Search />
              <Toaster />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}
