/**
 * External MCP servers the Factory's agents use (a database through MCP Toolbox, a log service…).
 *
 * The config shape is upstream Mastra's stored MCP client (`StorageMCPServerConfig`:
 * stdio `command`/`args`/`env` or http `url`), plus what the Factory adds: secrets kept apart,
 * which cards get the server (access) and what each of its tools may do (tool policy).
 * Pure: no I/O; the store keeps it, the server's hub runs it.
 */

import { z } from 'zod';

/**
 * What a tool call may do: run, run after a person allows it, or not exist for the agent.
 * `review` is never chosen by a person: a check puts it on a tool that is new since the last check
 * and writes or destroys (per its MCP annotations) — hidden from agents until someone decides.
 */
export const MCP_TOOL_POLICIES = ['allow', 'ask', 'deny', 'review'] as const;
export type McpToolPolicy = (typeof MCP_TOOL_POLICIES)[number];

/** Whether a policy keeps a tool from agents. */
export function mcpToolHidden(policy: McpToolPolicy): boolean {
  return policy === 'deny' || policy === 'review';
}

/** A server's default for its tools, with per-tool overrides. Nothing is forbidden unless someone says so. */
export interface McpToolPolicies {
  default: McpToolPolicy;
  tools: Record<string, McpToolPolicy>;
}

export const DEFAULT_MCP_TOOL_POLICIES: McpToolPolicies = { default: 'allow', tools: {} };

/**
 * The kinds of session in a Factory: its chat (the supervisor), members' own sessions not tied to
 * a card, and card sessions.
 */
export const MCP_SESSION_KINDS = ['chat', 'personal', 'cards'] as const;
export type McpSessionKind = (typeof MCP_SESSION_KINDS)[number];

/**
 * Which sessions of a Factory get a server: its chat, members' own sessions, card sessions — and
 * for cards optionally only some boards and phases (no boards → every board; no phases → every
 * phase). `sessions` absent is a row written before the kinds existed: no boards and no phases meant
 * every session, boards or phases meant cards only (`mcpAssignmentKinds`).
 */
export interface McpServerAssignment {
  factoryProjectId: string;
  sessions?: McpSessionKind[];
  boards?: string[];
  phases?: string[];
}

/** The session a server would run for. */
export interface McpSessionScope {
  factoryProjectId: string;
  /** Which kind of session: the Factory chat, a member's own session, or a card's. */
  kind: 'chat' | 'personal' | 'card';
  /** The card's board and phase, when the session works a card. */
  board?: string;
  phase?: string;
}

const NAME_RE = /^[a-z][a-z0-9-]{1,30}$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export const mcpToolPolicySchema = z.enum(MCP_TOOL_POLICIES);

export const mcpToolPoliciesSchema = z.object({
  default: mcpToolPolicySchema,
  tools: z.record(z.string().min(1).max(200), mcpToolPolicySchema),
});

export const mcpServerAssignmentSchema = z.object({
  factoryProjectId: z.string().min(1),
  sessions: z.array(z.enum(MCP_SESSION_KINDS)).max(3).optional(),
  boards: z.array(z.string().min(1)).max(50).optional(),
  phases: z.array(z.string().min(1)).max(100).optional(),
});

/** A plain (non-secret) environment variable or header. Secret ones are written separately and never read back. */
const plainMapSchema = z.record(z.string().regex(ENV_NAME_RE, 'Use letters, digits and _ only.'), z.string().max(4000));

/** An input filled from an account the organization already keeps, by reference (never a copy of its key). */
export const mcpCredentialRefSchema = z.object({
  kind: z.enum(['google-cloud-account']),
  id: z.string().min(1).max(64),
});
export type McpCredentialRef = z.infer<typeof mcpCredentialRefSchema>;

/**
 * How a server runs: a catalog entry (a pinned package described by its MCP Registry `server.json`),
 * a local command, or an address — upstream Mastra's stdio / http shapes plus the catalog.
 */
export const mcpServerLaunchSchema = z.discriminatedUnion('transport', [
  z.object({
    transport: z.literal('catalog'),
    /** The catalog entry's id (e.g. `mcp-toolbox`). */
    entry: z.string().min(1).max(64),
    /** Which way of running it (e.g. `firestore`); absent when the entry has one. */
    variant: z.string().min(1).max(64).optional(),
    /** Plain input values by input key (an environment variable name or an argument's value hint). */
    inputs: plainMapSchema.default({}),
    /** Inputs filled from the organization's accounts. */
    credentials: z.record(z.string().regex(ENV_NAME_RE), mcpCredentialRefSchema).default({}),
  }),
  z.object({
    transport: z.literal('stdio'),
    /** Rows written before the catalog; the boot migration turns them into catalog launches. */
    preset: z.string().min(1).optional(),
    command: z.string().min(1).max(500).optional(),
    args: z.array(z.string().max(2000)).max(50).default([]),
    env: plainMapSchema.default({}),
  }),
  z.object({
    transport: z.literal('http'),
    url: z.string().url(),
    headers: z.record(z.string().min(1).max(200), z.string().max(4000)).default({}),
  }),
]);
export type McpServerLaunch = z.infer<typeof mcpServerLaunchSchema>;

/**
 * Secret values, by kind: environment variables, headers, and files (a value written to a private
 * temp file at launch whose path goes into the named variable, e.g. GOOGLE_APPLICATION_CREDENTIALS).
 */
export const mcpServerSecretsSchema = z.object({
  env: plainMapSchema.default({}),
  headers: z.record(z.string().min(1).max(200), z.string().max(8000)).default({}),
  files: z.record(z.string().regex(ENV_NAME_RE), z.string().max(64_000)).default({}),
});
export type McpServerSecrets = z.infer<typeof mcpServerSecretsSchema>;

/** What a person writes to create or change a server. Secrets: a value sets it, `null` removes it, absent keeps it. */
export const mcpServerInputSchema = z.object({
  name: z.string().regex(NAME_RE, 'Use 2–31 lowercase letters, digits and dashes, starting with a letter.'),
  label: z.string().min(1).max(80),
  launch: mcpServerLaunchSchema,
  secrets: z
    .object({
      env: z.record(z.string().regex(ENV_NAME_RE), z.string().max(4000).nullable()).optional(),
      headers: z.record(z.string().min(1).max(200), z.string().max(8000).nullable()).optional(),
      files: z.record(z.string().regex(ENV_NAME_RE), z.string().max(64_000).nullable()).optional(),
    })
    .optional(),
  assignments: z.array(mcpServerAssignmentSchema).max(100).default([]),
  toolPolicies: mcpToolPoliciesSchema.default(DEFAULT_MCP_TOOL_POLICIES),
  maskPersonalData: z.boolean().default(true),
  enabled: z.boolean().default(true),
  /** How long one tool call may take before it fails (client side). */
  callTimeoutMs: z.number().int().min(1_000).max(600_000).optional(),
});
export type McpServerInput = z.infer<typeof mcpServerInputSchema>;

/** A tool call's time limit when the server sets none. */
export const DEFAULT_MCP_CALL_TIMEOUT_MS = 60_000;

/** Names of the secrets a server holds, never their values. */
export interface McpSecretNames {
  env: string[];
  headers: string[];
  files: string[];
}

/**
 * The integration that manages a server (Settings › Інтеграції › Сервіси): it decides the server's
 * config and which Factory gets it; people may change only its tool policy and masking. `key` is
 * the integration's own id for it (a Google Cloud binding's id), so a sync finds it again.
 */
export const mcpServerOwnerSchema = z.object({
  integration: z.string().min(1).max(64),
  key: z.string().min(1).max(128),
});
export type McpServerOwner = z.infer<typeof mcpServerOwnerSchema>;

/**
 * A server an integration wants to exist, as its settings say (desired state). The Factory's sync
 * creates, updates or removes the integration's servers to match; tool policy, masking and the
 * on/off switch a person set are kept.
 */
export interface ManagedMcpServerSpec {
  key: string;
  /** Preferred server name; a free variant is used if another server has it. */
  name: string;
  label: string;
  launch: McpServerLaunch;
  assignments: McpServerAssignment[];
}

/** A server as the API shows it. */
export interface McpServerView {
  id: string;
  name: string;
  label: string;
  /** Present when an integration manages the server. */
  owner?: McpServerOwner;
  launch: McpServerLaunch;
  secretNames: McpSecretNames;
  assignments: McpServerAssignment[];
  toolPolicies: McpToolPolicies;
  maskPersonalData: boolean;
  enabled: boolean;
  callTimeoutMs?: number;
  /** What the last check or session use found; absent until the server was checked or used. */
  health?: McpServerHealth;
  /** When and by whom it was added (a user id, or `integration:<id>` for a server an integration manages). */
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

/** What a tool may do, from its MCP annotations (`readOnlyHint`, `destructiveHint`). */
export type McpToolRisk = 'read' | 'write' | 'destructive' | 'unknown';

/** MCP tool annotations (spec 2025-03-26 `ToolAnnotations`); hints only — the server's word. */
export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** A tool as a check found it. */
export interface McpToolInfo {
  name: string;
  description: string;
  annotations?: McpToolAnnotations;
  /** The tool's input JSON Schema, as the server describes it. */
  inputSchema?: unknown;
}

/** A server's state: up, failing, waiting for a sign-in, switched off, or never checked. */
export type McpServerState = 'ok' | 'error' | 'needs_auth' | 'disabled' | 'unchecked';

/** What the last check (and the last session use) found, kept with the server. */
export interface McpServerHealth {
  state: Exclude<McpServerState, 'disabled' | 'unchecked'>;
  tools: McpToolInfo[];
  checkedAt?: string;
  lastUsedAt?: string;
  /** Masked: no tokens, emails or addresses. */
  error?: string;
  /** What kind of failure, so the page can explain it. */
  errorKind?: McpErrorKind;
}

export type McpErrorKind = 'version_mismatch' | 'missing_input' | 'auth_denied' | 'timeout' | 'spawn_failed' | 'other';

/** A tool's risk from its annotations: read-only, destructive, writing, or unknown when it says nothing. */
export function mcpToolRisk(annotations: McpToolAnnotations | undefined): McpToolRisk {
  if (!annotations) return 'unknown';
  if (annotations.readOnlyHint === true) return 'read';
  if (annotations.destructiveHint === true) return 'destructive';
  if (annotations.readOnlyHint === false) return 'write';
  return 'unknown';
}

/**
 * Tools to quarantine after a check (paperclip's MCP access governance): new since the previous
 * check, writing or destroying per their annotations, and with no policy of their own yet. A first
 * check (no previous tools) quarantines nothing: the person adding the server sees every tool.
 */
export function mcpToolsToQuarantine(
  previous: readonly McpToolInfo[] | undefined,
  current: readonly McpToolInfo[],
  policies: McpToolPolicies,
): string[] {
  if (!previous) return [];
  const known = new Set(previous.map(tool => tool.name));
  return current
    .filter(tool => !known.has(tool.name) && !(tool.name in policies.tools))
    .filter(tool => {
      const risk = mcpToolRisk(tool.annotations);
      return risk === 'write' || risk === 'destructive';
    })
    .map(tool => tool.name);
}

/** The state a server shows: off when switched off, never checked when nothing is known. */
export function mcpServerState(server: { enabled: boolean; health?: McpServerHealth }): McpServerState {
  if (!server.enabled) return 'disabled';
  return server.health?.state ?? 'unchecked';
}

/** Which session kinds an assignment covers; rows written before the kinds existed are read as they meant. */
export function mcpAssignmentKinds(assignment: McpServerAssignment): McpSessionKind[] {
  if (assignment.sessions) return assignment.sessions;
  return assignment.boards?.length || assignment.phases?.length ? ['cards'] : [...MCP_SESSION_KINDS];
}

/** Whether an assignment covers a session. */
export function mcpAssignmentMatches(assignment: McpServerAssignment, scope: McpSessionScope): boolean {
  if (assignment.factoryProjectId !== scope.factoryProjectId) return false;
  const kinds = mcpAssignmentKinds(assignment);
  if (scope.kind === 'chat') return kinds.includes('chat');
  if (scope.kind === 'personal') return kinds.includes('personal');
  if (!kinds.includes('cards')) return false;
  if (assignment.boards?.length && (!scope.board || !assignment.boards.includes(scope.board))) return false;
  if (assignment.phases?.length && (!scope.phase || !assignment.phases.includes(scope.phase))) return false;
  return true;
}

/** Whether a session gets a server: it is on and one of its assignments covers the session. */
export function mcpServerAvailable(
  server: { enabled: boolean; assignments: readonly McpServerAssignment[] },
  scope: McpSessionScope,
): boolean {
  return server.enabled && server.assignments.some(assignment => mcpAssignmentMatches(assignment, scope));
}

/** A tool's policy: its own override, else the server's default. */
export function mcpToolPolicy(policies: McpToolPolicies, tool: string): McpToolPolicy {
  return policies.tools[tool] ?? policies.default;
}

/** The name an agent sees a server's tool under (upstream Mastra's `serverName_toolName`). */
export function mcpAgentToolName(serverName: string, tool: string): string {
  return `${serverName}_${tool}`;
}
