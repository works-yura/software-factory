/**
 * Settings › Підключення: one list of what a Factory's agents connect to, whatever runs underneath.
 *
 * Two levels, as the stores already keep them:
 * - **Organization** — accounts and servers: Google Cloud service-account keys, MCP servers, the
 *   ClickUp token, the GitHub App, GitLab connections.
 * - **Factory** — a link to one of them: a Google Cloud binding (this Factory reads that project
 *   through that account), an MCP server's access entry for this Factory. «Відв'язати» drops the
 *   link and keeps the organization's account for other Factories.
 *
 * ClickUp, GitHub and GitLab are connected for the whole organization; a Factory has no link of its
 * own to drop (its intake routes and repositories say what it uses), so their rows say so.
 *
 * Each integration is a kind in {@link CONNECTION_KINDS}; the rows, the add catalog and the accounts
 * a Factory can link are built here from the integrations' own state, so the page holds no
 * integration-specific branching beyond its detail views.
 */

import type { McpCatalogEntry } from '@factory/core';
import { mcpServerState } from '@factory/core';

import type { ClickUpStatus } from '../../factory/services/clickup';
import type { GitLabStatus } from '../../factory/services/gitlab';
import type { GithubStatus } from '../../workspaces/services/github';
import type { FirebaseAccount, FirebaseBinding, FirebaseState } from '../services/firebase';
import type { McpServer, McpServersState } from '../services/mcpServers';

export type ConnectionKind = 'google-cloud' | 'mcp' | 'clickup' | 'github' | 'gitlab';

/** The add catalog's filter: tools agents call, and sources that bring work and code. */
export type ConnectionCategory = 'tools' | 'sources';

export interface ConnectionKindDescriptor {
  kind: ConnectionKind;
  category: ConnectionCategory;
  /** Runs as an MCP server (the row and catalog show the badge). */
  mcp: boolean;
  /** Connected for the whole organization: no Factory link to drop. */
  organizationWide: boolean;
}

export const CONNECTION_KINDS: Record<ConnectionKind, ConnectionKindDescriptor> = {
  'google-cloud': { kind: 'google-cloud', category: 'tools', mcp: false, organizationWide: false },
  mcp: { kind: 'mcp', category: 'tools', mcp: true, organizationWide: false },
  clickup: { kind: 'clickup', category: 'sources', mcp: false, organizationWide: true },
  github: { kind: 'github', category: 'sources', mcp: false, organizationWide: true },
  gitlab: { kind: 'gitlab', category: 'sources', mcp: false, organizationWide: true },
};

/** What a connection lets agents do, as the row lists it. */
export type ConnectionCapability =
  | { key: 'logs' }
  | { key: 'crashes'; count: number }
  | { key: 'database' }
  | { key: 'tools'; count: number }
  | { key: 'tasks' }
  | { key: 'repositories' };

/**
 * The row's status. MCP states come from the server's last check and use; `configured` is a link
 * nothing checks on its own (a Google Cloud binding without «База» — its check lives in the detail);
 * `reads-nothing` is a binding with everything off; `env` a connection made by the server's environment.
 */
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
  kind: ConnectionKind;
  /** A name the person gave, or the project/server it reaches. */
  title: string;
  mcp: boolean;
  account?: { name: string; detail?: string };
  capabilities: ConnectionCapability[];
  state: ConnectionState;
  scope: 'factory' | 'organization';
  /** The MCP server behind the row, when there is one (its health line, reconnect, rename). */
  server?: McpServer;
  binding?: FirebaseBinding;
  accountId?: string;
  /** Managed by an integration: config is that integration's, only tool policy and masking change here. */
  managed?: boolean;
}

export interface ConnectionSources {
  firebase?: FirebaseState;
  mcp?: McpServersState;
  clickup?: ClickUpStatus;
  github?: GithubStatus;
  gitlab?: GitLabStatus;
}

export const connectionId = {
  binding: (bindingId: string) => `google-cloud:${bindingId}`,
  server: (serverId: string) => `mcp:${serverId}`,
};

/** The integration id Google Cloud's managed servers carry as their owner (`integration-firebase`). */
const GOOGLE_CLOUD_OWNER = 'firebase';

/** The server an integration runs for a binding (Google Cloud's «База»), keyed by the binding. */
function managedServerFor(servers: readonly McpServer[], bindingId: string): McpServer | undefined {
  return servers.find(server => server.owner?.integration === GOOGLE_CLOUD_OWNER && server.owner.key === bindingId);
}

function bindingCapabilities(binding: FirebaseBinding): ConnectionCapability[] {
  return [
    ...(binding.logs ? [{ key: 'logs' } as const] : []),
    ...(binding.crashes && binding.apps.length > 0 ? [{ key: 'crashes', count: binding.apps.length } as const] : []),
    ...(binding.database?.enabled ? [{ key: 'database' } as const] : []),
  ];
}

function googleCloudRows(factoryId: string, firebase: FirebaseState, servers: readonly McpServer[]): ConnectionRow[] {
  const accountOf = (id: string): FirebaseAccount | undefined => firebase.accounts.find(account => account.id === id);
  return firebase.bindings
    .filter(binding => binding.factoryProjectId === factoryId)
    .map(binding => {
      const account = accountOf(binding.accountId);
      const server = managedServerFor(servers, binding.id);
      const capabilities = bindingCapabilities(binding);
      const state: ConnectionState = capabilities.length === 0 ? 'reads-nothing' : server ? mcpServerState(server) : 'configured';
      return {
        id: connectionId.binding(binding.id),
        kind: 'google-cloud',
        title: binding.projectId,
        mcp: false,
        ...(account ? { account: { name: account.name, detail: account.clientEmail } } : {}),
        capabilities,
        state,
        scope: 'factory',
        binding,
        ...(account ? { accountId: account.id } : {}),
        ...(server ? { server } : {}),
      } satisfies ConnectionRow;
    });
}

function mcpRows(factoryId: string, mcp: McpServersState, firebase: FirebaseState | undefined): ConnectionRow[] {
  const accountName = (id: string) => mcp.credentials['google-cloud-account']?.find(option => option.id === id);
  return mcp.servers
    .filter(server => server.assignments.some(assignment => assignment.factoryProjectId === factoryId))
    // A Google Cloud binding's «База» is part of that binding's row.
    .filter(server => !(server.owner?.integration === GOOGLE_CLOUD_OWNER && firebase?.bindings.some(binding => binding.id === server.owner?.key)))
    .map(server => {
      const credential = server.launch.transport === 'catalog' ? Object.values(server.launch.credentials)[0] : undefined;
      const option = credential ? accountName(credential.id) : undefined;
      const tools = server.health?.tools.length;
      return {
        id: connectionId.server(server.id),
        kind: 'mcp',
        title: server.label,
        mcp: true,
        ...(option ? { account: { name: option.name, ...(option.detail ? { detail: option.detail } : {}) } } : {}),
        capabilities: tools ? [{ key: 'tools', count: tools }] : [],
        state: mcpServerState(server),
        scope: 'factory',
        server,
        ...(server.owner ? { managed: true } : {}),
      } satisfies ConnectionRow;
    });
}

function sourceRows(sources: ConnectionSources): ConnectionRow[] {
  const rows: ConnectionRow[] = [];
  const { clickup, github, gitlab } = sources;
  if (clickup?.configured) {
    rows.push({
      id: 'clickup',
      kind: 'clickup',
      title: 'ClickUp',
      mcp: false,
      ...(clickup.workspaces.length ? { account: { name: clickup.workspaces.join(', ') } } : {}),
      capabilities: [{ key: 'tasks' }],
      state: clickup.connected ? 'connected' : 'error',
      scope: 'organization',
    });
  }
  if (github?.connected || github?.mode === 'token') {
    const logins = (github.installations ?? []).map(installation => installation.accountLogin).filter((login): login is string => Boolean(login));
    rows.push({
      id: 'github',
      kind: 'github',
      title: 'GitHub',
      mcp: false,
      ...(logins.length ? { account: { name: logins.join(', ') } } : {}),
      capabilities: [{ key: 'repositories' }, { key: 'tasks' }],
      state: github.mode === 'token' ? 'env' : 'connected',
      scope: 'organization',
    });
  }
  if (gitlab?.configured) {
    const labels = (gitlab.connections ?? []).map(connection => connection.accountLabel).filter((label): label is string => Boolean(label));
    rows.push({
      id: 'gitlab',
      kind: 'gitlab',
      title: 'GitLab',
      mcp: false,
      ...(labels.length ? { account: { name: labels.join(', ') } } : {}),
      capabilities: [{ key: 'repositories' }, { key: 'tasks' }],
      state: gitlab.mode === 'direct' ? 'env' : gitlab.reauthRequired ? 'needs_auth' : 'connected',
      scope: 'organization',
    });
  }
  return rows;
}

/** Everything the Factory connects to, Factory links first (Google Cloud, MCP), then organization-wide sources. */
export function factoryConnections(factoryId: string, sources: ConnectionSources): ConnectionRow[] {
  const servers = sources.mcp?.servers ?? [];
  return [
    ...(sources.firebase ? googleCloudRows(factoryId, sources.firebase, servers) : []),
    ...(sources.mcp ? mcpRows(factoryId, sources.mcp, sources.firebase) : []),
    ...sourceRows(sources),
  ];
}

/** One entry of «Додати підключення»: an integration, an MCP catalog server, or an own MCP server. */
export interface CatalogItem {
  /** `google-cloud`, `clickup`, `github`, `gitlab`, `mcp-entry:<id>`, `mcp-custom`. */
  id: string;
  kind: ConnectionKind;
  category: ConnectionCategory;
  mcp: boolean;
  /** Set for integrations: their name and summary come from the page's translations by kind. */
  entry?: McpCatalogEntry;
  /** Already connected for the organization (ClickUp, GitHub, GitLab) — opening shows it. */
  connected: boolean;
}

export function connectionCatalog(sources: ConnectionSources): CatalogItem[] {
  const entries = sources.mcp?.catalog ?? [];
  return [
    { id: 'google-cloud', kind: 'google-cloud', category: 'tools', mcp: false, connected: Boolean(sources.firebase?.accounts.length) },
    ...entries.map(entry => ({ id: `mcp-entry:${entry.id}`, kind: 'mcp' as const, category: 'tools' as const, mcp: true, entry, connected: false })),
    { id: 'mcp-custom', kind: 'mcp', category: 'tools', mcp: true, connected: false },
    { id: 'clickup', kind: 'clickup', category: 'sources', mcp: false, connected: Boolean(sources.clickup?.connected) },
    { id: 'github', kind: 'github', category: 'sources', mcp: false, connected: Boolean(sources.github?.connected || sources.github?.mode === 'token') },
    { id: 'gitlab', kind: 'gitlab', category: 'sources', mcp: false, connected: Boolean(sources.gitlab?.configured) },
  ];
}

/** An organization account or server this Factory is not linked to yet, offered in «Додати підключення». */
export interface LinkableAccount {
  id: string;
  kind: 'google-cloud' | 'mcp';
  name: string;
  detail?: string;
  /** The account (Google Cloud) or server (MCP) to link. */
  targetId: string;
}

/**
 * What the Factory can link from the organization: every Google Cloud account (a Factory may read
 * several projects through one account) and the MCP servers it has no access entry on. Servers an
 * integration manages are linked through that integration.
 */
export function linkableAccounts(factoryId: string, sources: ConnectionSources): LinkableAccount[] {
  const accounts = (sources.firebase?.accounts ?? []).map(account => ({
    id: `google-cloud:${account.id}`,
    kind: 'google-cloud' as const,
    name: account.name,
    detail: account.clientEmail,
    targetId: account.id,
  }));
  const servers = (sources.mcp?.servers ?? [])
    .filter(server => !server.owner && !server.assignments.some(assignment => assignment.factoryProjectId === factoryId))
    .map(server => ({ id: `mcp:${server.id}`, kind: 'mcp' as const, name: server.label, detail: server.name, targetId: server.id }));
  return [...accounts, ...servers];
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
