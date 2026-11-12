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
 * First-party integrations show what they give agents, never how they run: an MCP catalog entry an
 * integration runs under the hood (`entry.integration`, e.g. MCP Toolbox for Google Cloud's «База»)
 * is not offered in the catalog, and a server made from it is that integration's row («База»), not an
 * MCP row. MCP shows only for third-party and own servers.
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
  'google-cloud': { kind: 'google-cloud', category: 'tools', mcp: false, organizationWide: false, capabilities: ['tools'] },
  mcp: { kind: 'mcp', category: 'tools', mcp: true, organizationWide: false, capabilities: ['tools'] },
  clickup: { kind: 'clickup', category: 'sources', mcp: false, organizationWide: true, capabilities: ['tasks'] },
  github: { kind: 'github', category: 'sources', mcp: false, organizationWide: true, capabilities: ['code', 'tasks'] },
  gitlab: { kind: 'gitlab', category: 'sources', mcp: false, organizationWide: true, capabilities: ['code', 'tasks'] },
};

/** First-party integrations, the order «Додати підключення» lists them in. */
export const FIRST_PARTY: ReadonlyArray<Exclude<ConnectionKind, 'mcp'>> = ['google-cloud', 'clickup', 'github', 'gitlab'];

/** The catalog entry that connects GitHub with a personal access token (`github` is the GitHub App). */
export const GITHUB_TOKEN_ITEM = 'github-token';

/** What a connection lets agents do, as the row lists it. */
export type ConnectionCapability =
  | { key: 'logs' }
  | { key: 'crashes' }
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
  /** When and by whom the connection was made, where the integration records it. */
  createdAt?: string;
  createdBy?: string;
  /** What «Перейменувати» renames: the binding's own name, the server's label, or an organization connection's name. */
  rename?: 'binding' | 'server' | 'clickup' | 'github';
  /** The GitHub installation row a GitHub connection is (its rename and removal address). */
  installationId?: string;
  /** How a GitHub connection authenticates: the App, or a token. */
  githubAuth?: 'app' | 'token';
  /** GitHub: Factory project connections still using its repositories (removal waits for them). */
  projectConnections?: number;
  /** An organization connection's own actions, each either available or why not (shown, never hidden). */
  orgActions?: OrgActions;
}

/** Why an organization connection's action cannot be taken here; the menu says it under the item. */
export type OrgActionBlock = 'env' | 'admin' | 'platform';

/** «Перейменувати», «Перепідключити», «Видалити підключення» for ClickUp, GitHub, GitLab: `true`, or the reason not. */
export interface OrgActions {
  rename: true | OrgActionBlock;
  reconnect: true | OrgActionBlock;
  remove: true | OrgActionBlock;
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
    ...(binding.crashes && binding.apps.length > 0 ? [{ key: 'crashes' } as const] : []),
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
        title: binding.name ?? binding.projectId,
        rename: 'binding',
        ...(binding.createdAt ? { createdAt: binding.createdAt } : {}),
        ...(binding.createdBy ? { createdBy: binding.createdBy } : {}),
        mcp: false,
        ...(account ? { account: { name: account.name, detail: account.clientEmail } } : {}),
        capabilities,
        state,
        scope: 'factory',
        binding,
        ...(account ? { accountId: account.id } : {}),
        ...(server ? { server, managed: true } : {}),
      } satisfies ConnectionRow;
    });
}

/** The first-party integration a stored server belongs to: its owner, or the integration its catalog entry runs for. */
export function serverIntegration(server: McpServer, catalog: readonly McpCatalogEntry[]): Exclude<ConnectionKind, 'mcp'> | undefined {
  if (server.owner?.integration === GOOGLE_CLOUD_OWNER) return 'google-cloud';
  if (server.launch.transport !== 'catalog') return undefined;
  const entryId = server.launch.entry;
  return catalog.find(entry => entry.id === entryId)?.integration;
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
      const integration = serverIntegration(server, mcp.catalog);
      // A database an integration runs (Google Cloud's Firestore through MCP Toolbox): that
      // integration's «База», named by the project it reads, never by its transport.
      const project = server.launch.transport === 'catalog' ? server.launch.inputs.FIRESTORE_PROJECT : undefined;
      return {
        id: connectionId.server(server.id),
        kind: integration ?? 'mcp',
        title: integration ? (project ?? 'Firestore') : server.label,
        mcp: !integration,
        ...(!integration && !server.owner ? { rename: 'server' as const } : {}),
        ...(server.createdAt ? { createdAt: server.createdAt } : {}),
        ...(server.createdBy ? { createdBy: server.createdBy } : {}),
        ...(option ? { account: { name: option.name, ...(option.detail ? { detail: option.detail } : {}) } } : {}),
        capabilities: integration ? [{ key: 'database' }] : tools ? [{ key: 'tools', count: tools }] : [],
        state: mcpServerState(server),
        scope: 'factory',
        server,
        ...(server.owner ? { managed: true } : {}),
      } satisfies ConnectionRow;
    });
}

/**
 * The organization's ClickUp, GitHub and GitLab connections — the organization's, not a Factory's:
 * every Factory sees them. ClickUp is the organization's token; GitHub one row per installation
 * (the App on an account, or the server's token); GitLab the Mastra Platform connections, or the
 * server's own token. What can be renamed, reconnected and removed follows where the credential
 * lives: a token in the server's environment is changed there, a GitHub App installation on GitHub,
 * a Platform connection on Mastra Platform.
 */
function sourceRows(sources: ConnectionSources): ConnectionRow[] {
  const rows: ConnectionRow[] = [];
  const { clickup, github, gitlab } = sources;
  if (clickup?.configured) {
    const admin = clickup.canManage !== false || 'admin';
    rows.push({
      id: 'clickup',
      kind: 'clickup',
      title: clickup.name ?? 'ClickUp',
      mcp: false,
      ...(clickup.account || clickup.workspaces.length
        ? { account: { name: clickup.account?.username ?? clickup.workspaces.join(', '), ...(clickup.workspaces.length ? { detail: clickup.workspaces.join(', ') } : {}) } }
        : {}),
      capabilities: [{ key: 'tasks' }],
      state: clickup.connected ? 'connected' : 'error',
      scope: 'organization',
      rename: 'clickup',
      ...(clickup.connectedAt ? { createdAt: clickup.connectedAt } : {}),
      ...(clickup.connectedBy ? { createdBy: clickup.connectedBy } : {}),
      orgActions: { rename: admin, reconnect: admin, remove: admin },
    });
  }
  const installations = github?.installations ?? [];
  if (github?.connected || installations.length > 0) {
    const admin = github?.canManage !== false || 'admin';
    // One row per connection (an account): the App on it, or a token — stored by the organization,
    // or the server's legacy GITHUB_ACCESS_TOKEN.
    for (const installation of installations) {
      const fromEnv = installation.kind === 'token' && installation.tokenSource === 'env';
      rows.push({
        id: `github:${installation.installationId}`,
        kind: 'github',
        title: installation.name ?? installation.accountLogin ?? 'GitHub',
        mcp: false,
        ...(installation.accountLogin ? { account: { name: installation.accountLogin, ...(installation.accountType ? { detail: installation.accountType } : {}) } } : {}),
        capabilities: [{ key: 'repositories' }, { key: 'tasks' }],
        state: installation.needsAttention ? 'error' : fromEnv ? 'env' : 'connected',
        scope: 'organization',
        githubAuth: installation.kind === 'token' ? 'token' : 'app',
        ...(installation.projectConnections !== undefined ? { projectConnections: installation.projectConnections } : {}),
        ...(installation.id ? { rename: 'github' as const, installationId: installation.id } : {}),
        ...(installation.createdAt ? { createdAt: installation.createdAt } : {}),
        ...(installation.connectedBy ? { createdBy: installation.connectedBy } : {}),
        orgActions: {
          rename: installation.id ? admin : 'env',
          // The App is re-authorized on GitHub; a stored token is replaced in its connect step; the server's token in its environment.
          reconnect: fromEnv ? 'env' : admin,
          remove: fromEnv ? 'env' : installation.id ? admin : 'env',
        },
      });
    }
  }
  if (gitlab?.configured) {
    const direct = gitlab.mode === 'direct';
    const connections = gitlab.connections ?? [];
    for (const connection of direct || !connections.length ? [undefined] : connections) {
      rows.push({
        id: connection ? `gitlab:${connection.id}` : 'gitlab',
        kind: 'gitlab',
        title: connection?.accountLabel ?? 'GitLab',
        mcp: false,
        ...(connection?.accountLabel ? { account: { name: connection.accountLabel } } : {}),
        capabilities: [{ key: 'repositories' }, { key: 'tasks' }],
        state: direct ? 'env' : connection?.status === 'needs_reauth' || gitlab.reauthRequired ? 'needs_auth' : 'connected',
        scope: 'organization',
        orgActions: direct
          ? { rename: 'env', reconnect: 'env', remove: 'env' }
          : { rename: 'platform', reconnect: true, remove: 'platform' },
      });
    }
  }
  return rows;
}

/** Everything the Factory connects to: Google Cloud, ClickUp, GitHub, GitLab, then MCP servers. */
export function factoryConnections(factoryId: string, sources: ConnectionSources): ConnectionRow[] {
  const servers = sources.mcp?.servers ?? [];
  const order: ConnectionKind[] = ['google-cloud', 'clickup', 'github', 'gitlab', 'mcp'];
  // First-party integrations first, MCP servers last; within a kind, the order each source gives.
  return [
    ...(sources.firebase ? googleCloudRows(factoryId, sources.firebase, servers) : []),
    ...(sources.mcp ? mcpRows(factoryId, sources.mcp, sources.firebase) : []),
    ...sourceRows(sources),
  ]
    .map((row, index) => ({ row, index }))
    .sort((left, right) => order.indexOf(left.row.kind) - order.indexOf(right.row.kind) || left.index - right.index)
    .map(({ row }) => row);
}

/** One entry of «Додати підключення»: a first-party integration, a third-party MCP server, or an own one. */
export interface CatalogItem {
  /** `google-cloud`, `clickup`, `github` (the GitHub App), `github-token`, `gitlab`, `mcp-entry:<id>`, `mcp-custom`. */
  id: string;
  kind: ConnectionKind;
  category: ConnectionCategory;
  /** Listed under «Інше»: MCP servers, third-party or own. */
  section: 'integrations' | 'other';
  mcp: boolean;
  capabilities: CatalogCapability[];
  /** A third-party MCP catalog entry; first-party names come from the kind. */
  entry?: McpCatalogEntry;
  /** Already connected for the organization — opening shows it. */
  connected: boolean;
}

export function connectionCatalog(sources: ConnectionSources): CatalogItem[] {
  const connected: Record<(typeof FIRST_PARTY)[number], boolean> = {
    'google-cloud': Boolean(sources.firebase?.accounts.length),
    clickup: Boolean(sources.clickup?.connected),
    // GitHub can always take one more connection (another App installation or token), so its entries add.
    github: false,
    gitlab: Boolean(sources.gitlab?.configured),
  };
  // Entries an integration runs under the hood are that integration's business, not a choice.
  const thirdParty = (sources.mcp?.catalog ?? []).filter(entry => !entry.integration);
  const firstParty = (kind: (typeof FIRST_PARTY)[number], id: string = kind): CatalogItem => ({
    id,
    kind,
    category: CONNECTION_KINDS[kind].category,
    section: 'integrations',
    mcp: false,
    capabilities: CONNECTION_KINDS[kind].capabilities,
    connected: connected[kind],
  });
  return [
    // GitHub is two ways in: through the server's GitHub App (only when the server has one), or a personal access token.
    ...FIRST_PARTY.flatMap(kind =>
      kind !== 'github'
        ? [firstParty(kind)]
        : [...(sources.github?.appConfigured ? [firstParty('github')] : []), ...(sources.github?.enabled !== false ? [firstParty('github', GITHUB_TOKEN_ITEM)] : [])],
    ),
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

/** An organization account or server this Factory is not linked to yet, offered in «Додати підключення». */
export interface LinkableAccount {
  id: string;
  kind: ConnectionKind;
  /** An MCP server (linking gives this Factory access); otherwise a Google Cloud account. */
  server?: true;
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
  const catalog = sources.mcp?.catalog ?? [];
  const servers = (sources.mcp?.servers ?? [])
    .filter(server => !server.owner && !server.assignments.some(assignment => assignment.factoryProjectId === factoryId))
    .map(server => {
      const integration = serverIntegration(server, catalog);
      return { id: `mcp:${server.id}`, kind: integration ?? ('mcp' as const), name: server.label, detail: server.name, targetId: server.id, server: true as const };
    });
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
