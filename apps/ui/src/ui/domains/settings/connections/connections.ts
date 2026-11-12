/**
 * Settings › Підключення: one list of what a Factory's agents connect to, whatever runs underneath.
 *
 * Connectors the server describes (ADR-0035) arrive as {@link ConnectionView}s from
 * `/web/connections` — name, logo key, scope (the organization's, or this Factory's link), state,
 * actions and every string — and become rows of kind `connector` with no provider knowledge here.
 * MCP servers are the kind not moved yet: built here from the MCP servers' own state. A server an
 * integration runs under the hood (`owner`, e.g. Google Cloud's «База») is part of that
 * integration's connection, never a row of its own; catalog entries an integration runs are not
 * offered.
 */

import type { ConnectionsListResponse, ConnectionView, ConnectorView } from '@factory/contracts';
import type { McpCatalogEntry } from '@factory/core';
import { mcpServerState } from '@factory/core';

import type { McpServer, McpServersState } from '../services/mcpServers';

export type ConnectionKind = 'mcp';

/** A row's kind: one the page still builds itself, or `connector` — described by the server. */
export type RowKind = ConnectionKind | 'connector';

/** The add catalog's filter: tools agents call, and sources that bring work and code. */
export type ConnectionCategory = 'tools' | 'sources';

/** What an integration gives agents, as «Додати підключення» marks it with icons. */
export type CatalogCapability = 'tools' | 'tasks' | 'code';

export interface ConnectionKindDescriptor {
  kind: ConnectionKind;
  category: ConnectionCategory;
  /** Runs as a third-party MCP server (the row and catalog show the badge). */
  mcp: boolean;
  /** Connected for the whole organization: no Factory link to drop. */
  organizationWide: boolean;
  capabilities: CatalogCapability[];
}

export const CONNECTION_KINDS: Record<ConnectionKind, ConnectionKindDescriptor> = {
  mcp: { kind: 'mcp', category: 'tools', mcp: true, organizationWide: false, capabilities: ['tools'] },
};

/** What a connection lets agents do, as the row lists it. */
export type ConnectionCapability =
  | { key: 'logs' }
  | { key: 'crashes' }
  | { key: 'database' }
  | { key: 'tools'; count: number }
  | { key: 'tasks' }
  | { key: 'repositories' };

/** The row's status: MCP states from the server's last check and use; a connector's tone mapped in. */
export type ConnectionState =
  | 'ok'
  | 'error'
  | 'needs_auth'
  | 'unchecked'
  | 'disabled'
  | 'configured'
  | 'reads-nothing'
  | 'connected'
  | 'env';

export interface ConnectionRow {
  /** Stable key, also the `?connection=` value that opens it. */
  id: string;
  kind: RowKind;
  /** A name the person gave, or the project/server it reaches. */
  title: string;
  mcp: boolean;
  account?: { name: string; detail?: string };
  capabilities: ConnectionCapability[];
  state: ConnectionState;
  scope: 'factory' | 'organization';
  /** The MCP server behind the row, when there is one (its health line, reconnect, rename). */
  server?: McpServer;
  /** When and by whom the connection was made, where the integration records it. */
  createdAt?: string;
  createdBy?: string;
  /** What «Перейменувати» renames: the server's label. */
  rename?: 'server';
  /** A connection the server describes (kind `connector`): its name, logo, state, actions and copy. */
  view?: ConnectionView;
}


export interface ConnectionSources {
  mcp?: McpServersState;
  /** Every connection the server's connectors describe (`/web/connections`). */
  connections?: ConnectionsListResponse;
  /** The server's connectors and their connect methods (`/web/connections/methods`). */
  connectors?: ConnectorView[];
}

export const connectionId = {
  server: (serverId: string) => `mcp:${serverId}`,
};

function mcpRows(factoryId: string, mcp: McpServersState): ConnectionRow[] {
  const accountName = (kind: string, id: string) => mcp.credentials[kind as keyof McpServersState['credentials']]?.find(option => option.id === id);
  return mcp.servers
    .filter(server => server.assignments.some(assignment => assignment.factoryProjectId === factoryId))
    // A server an integration runs under the hood is part of that integration's connection.
    .filter(server => !server.owner)
    .map(server => {
      const credential = server.launch.transport === 'catalog' ? Object.values(server.launch.credentials)[0] : undefined;
      const option = credential ? accountName(credential.kind, credential.id) : undefined;
      const tools = server.health?.tools.length;
      return {
        id: connectionId.server(server.id),
        kind: 'mcp',
        title: server.label,
        mcp: true,
        rename: 'server' as const,
        ...(server.createdAt ? { createdAt: server.createdAt } : {}),
        ...(server.createdBy ? { createdBy: server.createdBy } : {}),
        ...(option ? { account: { name: option.name, ...(option.detail ? { detail: option.detail } : {}) } } : {}),
        capabilities: tools ? [{ key: 'tools', count: tools }] : [],
        state: mcpServerState(server),
        scope: 'factory',
        server,
      } satisfies ConnectionRow;
    });
}


/** The row's state word for the health verdict: the server's tone, in the page's states. */
const TONE_STATE: Record<ConnectionView['state']['tone'], ConnectionState> = {
  ok: 'connected',
  warning: 'needs_auth',
  error: 'error',
  idle: 'unchecked',
};

/** A connection the server describes, as a row: everything it shows comes from the view. */
export function connectorRow(view: ConnectionView): ConnectionRow {
  return {
    id: view.id,
    kind: 'connector',
    title: view.label,
    mcp: view.mcp === true,
    ...(view.accountLabel ? { account: { name: view.accountLabel, ...(view.accountDetail ? { detail: view.accountDetail } : {}) } } : {}),
    capabilities: [],
    state: TONE_STATE[view.state.tone],
    scope: view.scope,
    ...(view.createdAt ? { createdAt: view.createdAt } : {}),
    ...(view.createdBy ? { createdBy: view.createdBy } : {}),
    view,
  };
}

/** Everything the Factory connects to: the server's connectors, then MCP servers. */
export function factoryConnections(factoryId: string, sources: ConnectionSources): ConnectionRow[] {
  const order: RowKind[] = ['connector', 'mcp'];
  // Connectors first, MCP servers last; within a kind, the order each source gives.
  return [
    ...(sources.mcp ? mcpRows(factoryId, sources.mcp) : []),
    ...(sources.connections?.connections ?? []).map(connectorRow),
  ]
    .map((row, index) => ({ row, index }))
    .sort((left, right) => order.indexOf(left.row.kind) - order.indexOf(right.row.kind) || left.index - right.index)
    .map(({ row }) => row);
}

/** One entry of «Додати підключення»: a connector the server describes, or an MCP server. */
export interface CatalogItem {
  /** `connector:<id>`, `mcp-entry:<id>`, `mcp-custom`. */
  id: string;
  kind: RowKind;
  category: ConnectionCategory;
  /** Listed under «Інше»: MCP servers, third-party or own. */
  section: 'integrations' | 'other';
  mcp: boolean;
  capabilities: CatalogCapability[];
  /** A third-party MCP catalog entry; first-party names come from the kind. */
  entry?: McpCatalogEntry;
  /** A connector the server describes: its name, logo, capabilities and connect methods. */
  connector?: ConnectorView;
  /** Already connected for the organization — opening shows it. */
  connected: boolean;
}

export function connectionCatalog(sources: ConnectionSources): CatalogItem[] {
  // Entries an integration runs under the hood are that integration's business, not a choice.
  const thirdParty = (sources.mcp?.catalog ?? []).filter(entry => !entry.integration);
  // A connector can always take one more connection (another account), so its entry adds.
  const connectors = (sources.connectors ?? []).map(
    (connector): CatalogItem => ({
      id: `connector:${connector.id}`,
      kind: 'connector',
      category: connector.category,
      section: connector.mcp ? 'other' : 'integrations',
      mcp: connector.mcp === true,
      capabilities: [],
      connector,
      connected: false,
    }),
  );
  return [
    ...connectors,
    ...thirdParty.map(entry => ({
      id: `mcp-entry:${entry.id}`,
      kind: 'mcp' as const,
      category: 'tools' as const,
      section: 'other' as const,
      mcp: true,
      capabilities: ['tools' as const],
      entry,
      connected: false,
    })),
    { id: 'mcp-custom', kind: 'mcp', category: 'tools', section: 'other', mcp: true, capabilities: ['tools'], connected: false },
  ];
}

/** An organization MCP server this Factory has no access to yet, offered in «Додати підключення». */
export interface LinkableAccount {
  id: string;
  kind: ConnectionKind;
  server: true;
  name: string;
  detail?: string;
  /** The server to link. */
  targetId: string;
}

/** The organization's MCP servers this Factory has no access entry on; managed ones come with their integration. */
export function linkableAccounts(factoryId: string, sources: ConnectionSources): LinkableAccount[] {
  return (sources.mcp?.servers ?? [])
    .filter(server => !server.owner && !server.assignments.some(assignment => assignment.factoryProjectId === factoryId))
    .map(server => ({ id: `mcp:${server.id}`, kind: 'mcp' as const, name: server.label, detail: server.name, targetId: server.id, server: true as const }));
}

export type CatalogFilter = 'all' | ConnectionCategory;

/**
 * The add catalog after the person's search and filter: matching catalog items (by their shown
 * text, which the caller supplies) and matching organization accounts. The filter applies to
 * accounts too: both kinds that can be linked are tools.
 */
export function filterCatalog<Item extends { category: ConnectionCategory }>(
  items: readonly Item[],
  accounts: readonly LinkableAccount[],
  options: { query: string; filter: CatalogFilter; textOf: (item: Item) => string },
): { items: Item[]; accounts: LinkableAccount[] } {
  const needle = options.query.trim().toLowerCase();
  const inFilter = (category: ConnectionCategory) => options.filter === 'all' || options.filter === category;
  return {
    items: items.filter(item => inFilter(item.category) && (!needle || options.textOf(item).toLowerCase().includes(needle))),
    accounts: accounts.filter(
      account => inFilter('tools') && (!needle || `${account.name} ${account.detail ?? ''}`.toLowerCase().includes(needle)),
    ),
  };
}

/**
 * The row's state as a short verdict for the detail header and for rows that need attention:
 * `ok` (working, connected, set up, from the environment), `error`, `warning` (needs access, reads
 * nothing), `idle` (not checked yet, off).
 */
export function connectionHealth(state: ConnectionState): 'ok' | 'error' | 'warning' | 'idle' {
  if (state === 'error') return 'error';
  if (state === 'needs_auth' || state === 'reads-nothing') return 'warning';
  if (state === 'unchecked' || state === 'disabled') return 'idle';
  return 'ok';
}

export interface ActivityFilter {
  fieldId: 'connection' | 'tool' | 'outcome';
  operatorId: 'is' | 'is-not' | 'contains';
  value: string | string[] | number | boolean | Array<string | number | boolean>;
}

/** Calls kept by «Фільтр запитів»: every filter must match (`is`, `is-not`, `contains`; `is` with several values matches any). */
export function filterActivity<Call extends { serverLabel: string; tool: string; outcome: 'ok' | 'error' }>(
  calls: readonly Call[],
  filters: readonly ActivityFilter[],
): Call[] {
  const field = (call: Call, fieldId: ActivityFilter['fieldId']) =>
    fieldId === 'connection' ? call.serverLabel : fieldId === 'tool' ? call.tool : call.outcome;
  return calls.filter(call =>
    filters.every(filter => {
      const actual = field(call, filter.fieldId).toLowerCase();
      const values = (Array.isArray(filter.value) ? filter.value : [filter.value]).map(value => String(value).toLowerCase());
      if (filter.operatorId === 'contains') return values.some(value => actual.includes(value));
      const hit = values.includes(actual);
      return filter.operatorId === 'is-not' ? !hit : hit;
    }),
  );
}
