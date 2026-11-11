/**
 * External MCP servers the Factory's agents use (a database through MCP Toolbox, a log service…).
 *
 * The config shape is upstream Mastra's stored MCP client (`StorageMCPServerConfig`:
 * stdio `command`/`args`/`env` or http `url`), plus what the Factory adds: secrets kept apart,
 * which cards get the server (access) and what each of its tools may do (tool policy).
 * Pure: no I/O; the store keeps it, the server's hub runs it.
 */

import { z } from 'zod';

/** What a tool call may do: run, run after a person allows it, or not exist for the agent. */
export const MCP_TOOL_POLICIES = ['allow', 'ask', 'deny'] as const;
export type McpToolPolicy = (typeof MCP_TOOL_POLICIES)[number];

/** A server's default for its tools, with per-tool overrides. Nothing is forbidden unless someone says so. */
export interface McpToolPolicies {
  default: McpToolPolicy;
  tools: Record<string, McpToolPolicy>;
}

export const DEFAULT_MCP_TOOL_POLICIES: McpToolPolicies = { default: 'allow', tools: {} };

/**
 * Which cards get a server: a Factory, and optionally only some of its boards and phases.
 * No boards → every board; no phases → every phase. Sessions that are not a card's (a chat)
 * match an assignment only when it names no boards and no phases.
 */
export interface McpServerAssignment {
  factoryProjectId: string;
  boards?: string[];
  phases?: string[];
}

/** The session a server would run for. */
export interface McpSessionScope {
  factoryProjectId: string;
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
});
export type McpServerInput = z.infer<typeof mcpServerInputSchema>;

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
  updatedAt: string;
  updatedBy: string;
}

/** Whether an assignment covers a session. */
export function mcpAssignmentMatches(assignment: McpServerAssignment, scope: McpSessionScope): boolean {
  if (assignment.factoryProjectId !== scope.factoryProjectId) return false;
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
