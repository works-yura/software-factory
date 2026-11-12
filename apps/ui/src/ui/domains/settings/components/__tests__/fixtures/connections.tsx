import { Toaster } from '@mastra/playground-ui/components/Toaster';
import { http, HttpResponse } from 'msw';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';

import { server } from '../../../../../../../e2e/ui/msw-server';
import { renderWithProviders, TEST_BASE_URL } from '../../../../../../../e2e/ui/render';
import { DEFAULT_CONNECTION_PERMISSIONS } from '@factory/contracts/connections';
import type { ConnectionView, ConnectorView } from '@factory/contracts';

import type { McpServer } from '../../../services/mcpServers';
import { ConnectionsPageHeader } from '../../connections/ConnectionsPageHeader';
import { ConnectionsSection } from '../../connections/ConnectionsSection';

export const FACTORY_ID = 'factory-1';
export const MCP_BASE = `${TEST_BASE_URL}/web/mcp-servers`;


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
  permissions: DEFAULT_CONNECTION_PERMISSIONS,
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

/**
 * A FAKE agent connector (Robo Agent): the accounts a harness's sessions run on, connected by a CLI
 * sign-in the server runs — no URL, only a `waiting` note and an `authId` to ask about.
 */
export const roboAgentConnector: ConnectorView = {
  id: 'robo',
  name: 'Robo Agent',
  icon: 'robo',
  description: 'The Robo accounts Robo Agent sessions run on.',
  category: 'agents',
  provides: [{ key: 'agent', label: 'Runs Robo Agent sessions' }],
  capabilities: { multipleConnectionsPerToolkit: true, batchConnectionStatus: false, reauthorizeReusesConnectionId: true },
  permissions: DEFAULT_CONNECTION_PERMISSIONS,
  methods: [{ id: 'sign-in', label: 'Sign in with Robo', authKind: 'oauth', available: true }],
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

/** The MCP servers connector as the server describes it: link a server the organization has, or the editor. */
export const mcpConnector: ConnectorView = {
  id: 'mcp',
  name: 'MCP servers',
  icon: 'mcp',
  description: 'Third-party and own MCP servers.',
  category: 'tools',
  mcp: true,
  provides: [{ key: 'tools', label: 'Tools' }],
  capabilities: { multipleConnectionsPerToolkit: true, batchConnectionStatus: false, reauthorizeReusesConnectionId: true },
  permissions: DEFAULT_CONNECTION_PERMISSIONS,
  methods: [
    {
      id: 'link',
      label: 'A server of the organization',
      authKind: 'apiKey',
      fields: [{ name: 'serverId', displayName: 'Server', type: 'select', options: [{ value: 'srv-notes', label: 'Notes' }], required: true }],
      submitLabel: 'Link',
      available: true,
    },
    { id: 'entry:mcp-toolbox', label: 'Database (MCP Toolbox)', authKind: 'apiKey', available: true, editor: { component: 'mcp-server', params: { entry: 'mcp-toolbox' } } },
    { id: 'custom', label: 'Own MCP server', authKind: 'apiKey', available: true, editor: { component: 'mcp-server', params: { custom: 'true' } } },
  ],
};

/** An MCP server this Factory has access to, as the server lists it (its words for the state included). */
export function mcpConnection(id: string, label: string, overrides: Partial<ConnectionView> = {}): ConnectionView {
  return {
    id: `mcp:${id}`,
    connector: { id: 'mcp', name: 'MCP servers', icon: 'mcp' },
    status: 'active',
    displayName: label,
    accountLabel: null,
    label,
    mcp: true,
    provides: [],
    state: { tone: 'idle', label: 'Not checked yet' },
    scope: 'factory',
    actions: { rename: true, reconnect: { method: { id: 'check', label: 'Check the connection', authKind: 'apiKey', fields: [], available: true } }, unlink: true, remove: true },
    ...overrides,
  };
}

/** Sentry: an own server that fails with a refused account. */
export const sentryConnection = mcpConnection('srv-sentry', 'Sentry', {
  state: { tone: 'error', label: 'Error', message: 'The account was refused access; give it the role the server needs. (401)' },
});

/**
 * The integrations' state around the MCP servers a test brings: a FAKE server connector (Acme Cloud
 * — the page must render it from the server's descriptors alone) and the MCP connector, one
 * connection of each, no activity.
 */
export function useIntegrationHandlers(options: { connections?: ConnectionView[]; connectors?: ConnectorView[] } = {}) {
  server.use(
    http.get(`${TEST_BASE_URL}/web/factory/projects`, () =>
      HttpResponse.json({ projects: [{ id: FACTORY_ID, name: 'syncts', repositories: [] }] }),
    ),
    http.get(`${TEST_BASE_URL}/web/clickup/status`, () =>
      HttpResponse.json({ configured: true, connected: true, workspaces: ['eclipt.ai'], intervalSeconds: 60 }),
    ),
    http.get(`${TEST_BASE_URL}/web/intake/config`, () =>
      HttpResponse.json({ config: { github: { enabled: false, sourceIds: null }, gitlab: { enabled: false, sourceIds: null }, clickup: { enabled: true, sourceIds: null } } }),
    ),
    http.get(`${TEST_BASE_URL}/web/connections`, () =>
      HttpResponse.json({ connections: options.connections ?? [acmeConnection, sentryConnection], failures: [], copy: { organizationWide: 'Whole organization' } }),
    ),
    http.get(`${TEST_BASE_URL}/web/connections/:id/detail`, () => HttpResponse.json({ sections: [] })),
    http.get(`${TEST_BASE_URL}/web/connections/methods`, () => HttpResponse.json({ connectors: options.connectors ?? [acmeConnector, mcpConnector] })),
    http.get(`${TEST_BASE_URL}/web/connections/activity`, () => HttpResponse.json({ since: '2026-11-11T12:00:00.000Z', total: 0, errors: 0, calls: [], truncated: false, failures: [] })),
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
