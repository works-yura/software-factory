import { describe, expect, it } from 'vitest';

import { DEFAULT_CONNECTION_PERMISSIONS } from '@factory/contracts';
import type { ConnectorView } from '@factory/contracts';

import { catalogText, connectionCatalog, filterActivity, filterCatalog } from './connections';

/** Connectors this page knows nothing about: everything it shows comes from these descriptors. */
const connector = (id: string, overrides: Partial<ConnectorView> = {}): ConnectorView => ({
  id,
  name: `${id[0]!.toUpperCase()}${id.slice(1)} Cloud`,
  icon: id,
  description: `Tickets from ${id}.`,
  category: 'sources',
  provides: [{ key: 'tasks', label: 'Tickets' }],
  capabilities: { multipleConnectionsPerToolkit: true, batchConnectionStatus: false, reauthorizeReusesConnectionId: true },
  permissions: DEFAULT_CONNECTION_PERMISSIONS,
  methods: [{ id: 'key', label: 'API key', authKind: 'apiKey', fields: [], available: true }],
  ...overrides,
});
const acme = connector('acme');
const tools = connector('tooly', {
  category: 'tools',
  mcp: true,
  methods: [{ id: 'entry:weather', label: 'Weather', description: 'Forecasts by city', authKind: 'apiKey', available: true }],
});

describe('filterActivity', () => {
  const calls = [
    { connectionLabel: 'Firestore syncta', tool: 'list_collections', outcome: 'ok' as const },
    { connectionLabel: 'Sentry', tool: 'search_issues', outcome: 'error' as const },
    { connectionLabel: 'Firestore syncta', tool: 'query_collection', outcome: 'error' as const },
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

describe('connectionCatalog', () => {
  it('lists every connector the server describes; MCP ones under «Інше»', () => {
    expect(connectionCatalog([acme, tools]).map(item => [item.id, item.section, item.category])).toEqual([
      ['connector:acme', 'integrations', 'sources'],
      ['connector:tooly', 'other', 'tools'],
    ]);
  });
});

describe('filterCatalog', () => {
  const items = connectionCatalog([acme, tools]);

  it('narrows by category', () => {
    expect(filterCatalog(items, { query: '', filter: 'sources' }).map(item => item.id)).toEqual(['connector:acme']);
    expect(filterCatalog(items, { query: '', filter: 'tools' }).map(item => item.id)).toEqual(['connector:tooly']);
  });

  it("searches the connector's name, line, and its methods' names and lines", () => {
    expect(catalogText(items[1]!)).toContain('Forecasts by city');
    expect(filterCatalog(items, { query: 'forecast', filter: 'all' }).map(item => item.id)).toEqual(['connector:tooly']);
    expect(filterCatalog(items, { query: 'acme', filter: 'all' }).map(item => item.id)).toEqual(['connector:acme']);
    expect(filterCatalog(items, { query: 'nothing like it', filter: 'all' })).toEqual([]);
  });
});
