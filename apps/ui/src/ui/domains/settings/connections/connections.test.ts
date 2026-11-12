import { describe, expect, it } from 'vitest';

import { mcpCatalogEntry } from '@factory/core';

import toolboxOverlay from '../../../../../../../packages/server/src/mcp-servers/catalog/mcp-toolbox.factory.json';
import toolboxManifest from '../../../../../../../packages/server/src/mcp-servers/catalog/mcp-toolbox.server.json';
import type { McpServer, McpServersState } from '../services/mcpServers';
import { connectionCatalog, connectionHealth, factoryConnections, filterActivity, filterCatalog, linkableAccounts } from './connections';
import type { ConnectionState } from './connections';
import type { ConnectionView, ConnectorView } from '@factory/contracts';

/** A connector this page knows nothing about: everything it shows comes from these descriptors. */
const fakeView = (id: string, overrides: Partial<ConnectionView> = {}): ConnectionView => ({
  id: `acme:${id}`,
  connector: { id: 'acme', name: 'Acme Cloud', icon: 'acme' },
  label: `Acme ${id}`,
  status: 'active',
  displayName: null,
  accountLabel: null,
  provides: [{ key: 'tasks', label: 'Tickets' }],
  state: { tone: 'ok', label: 'Live' },
  scope: 'organization',
  actions: { rename: true, remove: true },
  ...overrides,
});
const fakeConnector: ConnectorView = {
  id: 'acme',
  name: 'Acme Cloud',
  icon: 'acme',
  description: 'Tickets from Acme.',
  category: 'sources',
  provides: [{ key: 'tasks', label: 'Tickets' }],
  capabilities: { multipleConnectionsPerToolkit: true, batchConnectionStatus: false, reauthorizeReusesConnectionId: true },
  methods: [{ id: 'key', label: 'API key', authKind: 'apiKey', fields: [], available: true }],
};
const listed = (...connections: ConnectionView[]) => ({ connections, failures: [], copy: { organizationWide: 'Everyone' } });

describe('filterActivity', () => {
  const calls = [
    { serverLabel: 'Firestore syncta', tool: 'list_collections', outcome: 'ok' as const },
    { serverLabel: 'Sentry', tool: 'search_issues', outcome: 'error' as const },
    { serverLabel: 'Firestore syncta', tool: 'query_collection', outcome: 'error' as const },
  ];

  it('keeps calls every filter matches: is, is not, contains, and is with several values', () => {
    expect(filterActivity(calls, [{ fieldId: 'outcome', operatorId: 'is', value: 'error' }]).map(call => call.tool)).toEqual(['search_issues', 'query_collection']);
    expect(
      filterActivity(calls, [
        { fieldId: 'connection', operatorId: 'is-not', value: 'Sentry' },
        { fieldId: 'tool', operatorId: 'contains', value: 'QUERY' },
      ]).map(call => call.tool),
    ).toEqual(['query_collection']);
    expect(filterActivity(calls, [{ fieldId: 'tool', operatorId: 'is', value: ['search_issues', 'list_collections'] }])).toHaveLength(2);
  });
});

describe('organization connections', () => {
  it("take a server connector's actions, reasons included, as the server sends them", () => {
    const rows = factoryConnections('syncts', {
      connections: listed(fakeView('1', { createdAt: '2026-11-02T00:00:00.000Z', createdBy: 'u2', actions: { rename: { reason: 'Admins only' } } })),
    });
    expect(rows.map(row => [row.id, row.title, row.scope, row.view?.actions])).toEqual([
      ['acme:1', 'Acme 1', 'organization', { rename: { reason: 'Admins only' } }],
    ]);
    expect(rows[0]).toMatchObject({ kind: 'connector', createdAt: '2026-11-02T00:00:00.000Z', createdBy: 'u2' });
  });
});

describe('connectionHealth', () => {
  it('turns a row state into the header verdict', () => {
    const states: ConnectionState[] = ['ok', 'connected', 'env', 'configured', 'error', 'needs_auth', 'reads-nothing', 'unchecked', 'disabled'];
    expect(states.map(connectionHealth)).toEqual(['ok', 'ok', 'ok', 'ok', 'error', 'warning', 'warning', 'idle', 'idle']);
  });
});

function server(overrides: Partial<McpServer>): McpServer {
  return {
    id: 'srv',
    name: 'srv',
    label: 'Server',
    launch: { transport: 'http', url: 'https://example.test/mcp', headers: {} },
    secretNames: { env: [], headers: [], files: [] },
    assignments: [],
    toolPolicies: { default: 'allow', tools: {} },
    maskPersonalData: true,
    enabled: true,
    updatedAt: '2026-11-12T00:00:00.000Z',
    updatedBy: 'u1',
    ...overrides,
  };
}

const managed = server({
  id: 'srv-db',
  name: 'db-syncta-57c6a',
  label: 'Firestore syncta-57c6a',
  owner: { integration: 'firebase', key: 'b-1' },
  assignments: [{ factoryProjectId: 'syncts' }],
  health: { state: 'ok', tools: [{ name: 'list_collections', description: '' }] },
});
const toolbox = server({
  id: 'srv-toolbox',
  name: 'toolbox',
  label: 'База даних (MCP Toolbox)',
  launch: {
    transport: 'catalog',
    entry: 'mcp-toolbox',
    variant: 'firestore',
    inputs: {},
    credentials: { GOOGLE_APPLICATION_CREDENTIALS: { kind: 'google-cloud-account', id: 'acc-1' } },
  },
  assignments: [{ factoryProjectId: 'syncts', sessions: ['chat'] }],
});
const elsewhere = server({ id: 'srv-other', name: 'sentry', label: 'Sentry', assignments: [{ factoryProjectId: 'other' }] });

const toolboxEntry = mcpCatalogEntry(toolboxManifest, toolboxOverlay);
const sentry = server({ id: 'srv-sentry', name: 'sentry', label: 'Sentry', assignments: [{ factoryProjectId: 'syncts' }] });

const mcp: McpServersState = {
  servers: [managed, toolbox, sentry, elsewhere],
  catalog: [toolboxEntry, { ...toolboxEntry, id: 'weather', integration: undefined }],
  credentials: { 'google-cloud-account': [{ id: 'acc-1', name: 'Syncta', detail: 'factory@syncta-57c6a.iam.gserviceaccount.com' }] },
  canEdit: true,
};

describe('factoryConnections', () => {
  const rows = factoryConnections('syncts', {
    mcp,
    connections: listed(fakeView('4242', { accountLabel: 'yura', status: 'needs_reauth', state: { tone: 'warning', label: 'Needs a look' } })),
  });

  it("lists the server's connectors, then this Factory's MCP servers; never one an integration runs under the hood", () => {
    expect(rows.map(row => [row.id, row.kind, row.scope])).toEqual([
      ['acme:4242', 'connector', 'organization'],
      ['mcp:srv-toolbox', 'mcp', 'factory'],
      ['mcp:srv-sentry', 'mcp', 'factory'],
    ]);
  });

  it("takes a server connector's row from its view: title, account and the tone as the health verdict", () => {
    const acme = rows.find(row => row.id === 'acme:4242');
    expect(acme).toMatchObject({ title: 'Acme 4242', account: { name: 'yura' }, state: 'needs_auth', capabilities: [] });
    expect(connectionHealth(acme!.state)).toBe('warning');
  });

  it('names the account an MCP server reads through', () => {
    expect(rows[1]).toMatchObject({ title: 'База даних (MCP Toolbox)', account: { name: 'Syncta' } });
  });

  it('marks an own server MCP', () => {
    expect(rows[2]).toMatchObject({ kind: 'mcp', title: 'Sentry', mcp: true });
  });

});

describe('linkableAccounts', () => {
  it("offers the MCP servers the Factory has no access to, never a managed one", () => {
    expect(linkableAccounts('syncts', { mcp }).map(account => [account.id, account.kind])).toEqual([['mcp:srv-other', 'mcp']]);
  });
});

describe('connectionCatalog', () => {
  it('offers the server\'s connectors, then third-party and own MCP servers under «Інше»; never an entry an integration runs', () => {
    expect(connectionCatalog({ mcp, connectors: [fakeConnector] }).map(item => [item.id, item.section, item.mcp])).toEqual([
      ['connector:acme', 'integrations', false],
      ['mcp-entry:weather', 'other', true],
      ['mcp-custom', 'other', true],
    ]);
  });
});

describe('filterCatalog', () => {
  const items = connectionCatalog({ mcp, connectors: [fakeConnector] });
  const text = (item: { id: string }) => item.id;

  it('narrows by category: sources leave out tools and accounts', () => {
    const result = filterCatalog(items, linkableAccounts('syncts', { mcp }), { query: '', filter: 'sources', textOf: text });
    expect(result.items.map(item => item.id)).toEqual(['connector:acme']);
    expect(result.accounts).toEqual([]);
  });

  it('searches catalog text and the servers by name', () => {
    const result = filterCatalog(items, linkableAccounts('syncts', { mcp }), { query: 'sentry', filter: 'all', textOf: text });
    expect(result.items).toEqual([]);
    expect(result.accounts.map(account => account.name)).toEqual(['Sentry']);
  });
});
