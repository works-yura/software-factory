/**
 * Browser-side calls for Settings › MCP-сервери: the organization's external MCP servers. Secret
 * values are sent on save and never come back — only their names.
 */

import type { McpCatalogEntry } from '@factory/core';

import { translator } from '../../../i18n/t';

const tk = translator('settings');

export type McpToolPolicy = 'allow' | 'ask' | 'deny';

export interface McpToolPolicies {
  default: McpToolPolicy;
  tools: Record<string, McpToolPolicy>;
}

export interface McpServerAssignment {
  factoryProjectId: string;
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
  launch: McpServerLaunch;
  secretNames: { env: string[]; headers: string[]; files: string[] };
  assignments: McpServerAssignment[];
  toolPolicies: McpToolPolicies;
  maskPersonalData: boolean;
  enabled: boolean;
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
}

export interface McpServerStatus {
  connected: boolean;
  toolCount: number;
  tools: Array<{ name: string; description: string; policy: McpToolPolicy }>;
  error?: string;
  checkedAt: string;
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
  };
}
