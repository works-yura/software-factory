/**
 * Browser-side calls for Settings › MCP-сервери: the organization's external MCP servers. Secret
 * values are sent on save and never come back — only their names.
 */

import type { McpCatalogEntry, McpErrorKind, McpServerHealth, McpSessionKind, McpToolInfo, McpToolRisk } from '@factory/core';

export type { McpErrorKind, McpServerHealth, McpSessionKind, McpToolInfo, McpToolRisk };

import { translator } from '../../../i18n/t';

const tk = translator('settings');

/** `review` is set by a check on a new writing tool (hidden from agents); people choose the other three. */
export type McpToolPolicy = 'allow' | 'ask' | 'deny' | 'review';

export interface McpToolPolicies {
  default: McpToolPolicy;
  tools: Record<string, McpToolPolicy>;
}

export interface McpServerAssignment {
  factoryProjectId: string;
  /** Which sessions: the Factory chat, members' own sessions, cards. Absent on rows written before kinds. */
  sessions?: McpSessionKind[];
  boards?: string[];
  phases?: string[];
}

export interface McpCredentialRef {
  kind: 'google-cloud-account';
  id: string;
}

export type McpServerLaunch =
  | {
      transport: 'catalog';
      entry: string;
      variant?: string;
      inputs: Record<string, string>;
      credentials: Record<string, McpCredentialRef>;
    }
  | { transport: 'stdio'; preset?: string; command?: string; args: string[]; env: Record<string, string> }
  | { transport: 'http'; url: string; headers: Record<string, string> };

export interface McpServer {
  id: string;
  name: string;
  label: string;
  /** The integration that manages the server (Google Cloud's «База»); people change only its tool policy and masking. */
  owner?: { integration: string; key: string };
  launch: McpServerLaunch;
  secretNames: { env: string[]; headers: string[]; files: string[] };
  assignments: McpServerAssignment[];
  toolPolicies: McpToolPolicies;
  maskPersonalData: boolean;
  enabled: boolean;
  callTimeoutMs?: number;
  /** What the last check and session use found. */
  health?: McpServerHealth;
  /** When and by whom it was added (`integration:<id>` for one an integration manages). */
  createdAt?: string;
  createdBy?: string;
  updatedAt: string;
  updatedBy: string;
}

export interface McpCredentialOption {
  id: string;
  name: string;
  detail?: string;
}

export interface McpServersState {
  servers: McpServer[];
  /** MCP Registry `server.json` entries with the Factory overlay. */
  catalog: McpCatalogEntry[];
  /** The organization's accounts an input can be filled from, by kind. */
  credentials: Partial<Record<McpCredentialRef['kind'], McpCredentialOption[]>>;
  canEdit: boolean;
}

/** What a save sends. Secrets: a value sets it, `null` removes it, absent keeps it. */
export interface McpServerInput {
  name: string;
  label: string;
  launch: McpServerLaunch;
  secrets?: {
    env?: Record<string, string | null>;
    headers?: Record<string, string | null>;
    files?: Record<string, string | null>;
  };
  assignments: McpServerAssignment[];
  toolPolicies: McpToolPolicies;
  maskPersonalData: boolean;
  enabled: boolean;
  callTimeoutMs?: number;
}

export interface McpServerStatus {
  connected: boolean;
  toolCount: number;
  tools: Array<McpToolInfo & { policy: McpToolPolicy; risk: McpToolRisk }>;
  error?: string;
  errorKind?: McpErrorKind;
  checkedAt: string;
  /** Tools this check put under review. */
  quarantined?: string[];
}

/** One run of «Спробувати». */
export interface McpToolTrial {
  ok: boolean;
  output?: unknown;
  error?: string;
  errorKind?: McpErrorKind;
  durationMs: number;
}

/** One call to a server's tool, from the audit trail. */
export interface McpServerCall {
  at: string;
  tool: string;
  outcome: 'ok' | 'error';
  durationMs?: number;
  sessionId?: string;
  factoryProjectId?: string;
  tried: boolean;
}

/** One call in a Factory's «Активність»: which server, which tool, how it went. */
export interface McpActivityCall extends McpServerCall {
  serverId: string;
  serverLabel: string;
}

/** A Factory's agent calls through every MCP server in a window (24 h by default). */
export interface McpActivity {
  since: string;
  total: number;
  errors: number;
  /** The newest calls (up to 50). */
  calls: McpActivityCall[];
  /** More calls than were read: the counts are a lower bound. */
  truncated: boolean;
}

export class McpServerRequestError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function request<T>(baseUrl: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { Accept: 'application/json', ...(init?.body ? { 'content-type': 'application/json' } : {}) },
    credentials: 'include',
  });
  if (!res.ok) {
    let body: Record<string, unknown> = {};
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      /* not JSON */
    }
    const message =
      (body.message as string | undefined) ?? (body.error as string | undefined) ?? tk('mcpServers.requestFailed', { status: res.status });
    throw new McpServerRequestError(message, res.status);
  }
  return (await res.json()) as T;
}

const json = (method: string, body?: unknown): RequestInit => ({ method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });

export const fetchMcpServers = (baseUrl: string) => request<McpServersState>(baseUrl, '/web/mcp-servers');

/** Values a Factory's own bindings suggest for a catalog input (its Google Cloud project). */
export const fetchMcpSuggestions = async (baseUrl: string, factoryProjectId: string) =>
  (
    await request<{ suggestions: Partial<Record<'google-cloud-project', string>> }>(
      baseUrl,
      `/web/mcp-servers/suggestions?factoryProjectId=${encodeURIComponent(factoryProjectId)}`,
    )
  ).suggestions;

export const saveMcpServer = async (baseUrl: string, input: McpServerInput & { id?: string }): Promise<McpServer> => {
  const { id, ...body } = input;
  const result = id
    ? await request<{ server: McpServer }>(baseUrl, `/web/mcp-servers/${encodeURIComponent(id)}`, json('PUT', body))
    : await request<{ server: McpServer }>(baseUrl, '/web/mcp-servers', json('POST', body));
  return result.server;
};

export const deleteMcpServer = (baseUrl: string, id: string) =>
  request<{ deleted: true }>(baseUrl, `/web/mcp-servers/${encodeURIComponent(id)}`, json('DELETE'));

export const checkMcpServer = async (baseUrl: string, id: string): Promise<McpServerStatus> =>
  (await request<{ status: McpServerStatus }>(baseUrl, `/web/mcp-servers/${encodeURIComponent(id)}/status`, json('POST'))).status;

/** Starts the form's config without saving it (the stored secrets of `id` fill what was not retyped). */
export const checkMcpServerDraft = async (baseUrl: string, body: { id?: string; server: McpServerInput }): Promise<McpServerStatus> =>
  (await request<{ status: McpServerStatus }>(baseUrl, '/web/mcp-servers/check', json('POST', body))).status;

/** Choices an account can see for an input: never fails — a refusal comes back as `denied`. */
export interface DiscoveryResult {
  items: Array<{ value: string; label?: string; detail?: string }>;
  default?: string;
  denied?: { role?: string; message: string };
}

export interface McpDiscoveryRequest {
  credential: McpCredentialRef;
  from: 'google-cloud-projects' | 'firestore-databases';
  context: Record<string, string>;
}

export const discoverMcpChoices = (baseUrl: string, body: McpDiscoveryRequest) =>
  request<DiscoveryResult>(baseUrl, '/web/mcp-servers/discover', json('POST', body));

/** «Перепідключити»: stops the server's running instances and checks it again. */
export const reconnectMcpServer = async (baseUrl: string, id: string): Promise<McpServerStatus> =>
  (await request<{ status: McpServerStatus }>(baseUrl, `/web/mcp-servers/${encodeURIComponent(id)}/reconnect`, json('POST'))).status;

/** «Спробувати»: runs one read-only tool with the given arguments. */
export const tryMcpTool = async (baseUrl: string, id: string, tool: string, args: Record<string, unknown>): Promise<McpToolTrial> =>
  (await request<{ trial: McpToolTrial }>(baseUrl, `/web/mcp-servers/${encodeURIComponent(id)}/try`, json('POST', { tool, arguments: args }))).trial;

/** The server's recent tool calls (no payloads). */
export const fetchMcpServerCalls = async (baseUrl: string, id: string): Promise<McpServerCall[]> =>
  (await request<{ calls: McpServerCall[] }>(baseUrl, `/web/mcp-servers/${encodeURIComponent(id)}/calls`)).calls;

/** «Активність» on Підключення: the Factory's agents' calls through all its servers in the last `hours`. */
export const fetchMcpActivity = (baseUrl: string, factoryProjectId: string, hours = 24) =>
  request<McpActivity>(baseUrl, `/web/mcp-servers/activity?factoryProjectId=${encodeURIComponent(factoryProjectId)}&hours=${hours}`);

/** A stored server as the form's starting point (secrets are never known: only their names). */
export function serverToInput(server: McpServer): McpServerInput {
  return {
    name: server.name,
    label: server.label,
    launch: server.launch,
    assignments: server.assignments,
    toolPolicies: server.toolPolicies,
    maskPersonalData: server.maskPersonalData,
    enabled: server.enabled,
    ...(server.callTimeoutMs ? { callTimeoutMs: server.callTimeoutMs } : {}),
  };
}
