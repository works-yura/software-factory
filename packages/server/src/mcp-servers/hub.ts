import { randomUUID } from 'node:crypto';

import { MCPClient } from '@mastra/mcp';
import { createTool } from '@mastra/core/tools';
import type { Tool } from '@mastra/core/tools';

import { redactDeep, redactText } from '@factory/capabilities';
import {
  DEFAULT_MCP_CALL_TIMEOUT_MS,
  mcpAgentToolName,
  mcpServerAvailable,
  mcpToolHidden,
  mcpToolPolicy,
  mcpToolRisk,
  mcpToolsToQuarantine,
} from '@factory/core';
import type {
  McpCredentialRef,
  McpErrorKind,
  McpServerHealth,
  McpSessionScope,
  McpToolAnnotations,
  McpToolInfo,
  McpToolPolicy,
  McpToolRisk,
} from '@factory/core';
import type { McpServerRecord } from '@factory/store';

import { prepareMcpServer } from './launch.ts';
import type { PreparedMcpServer, PrepareMcpServerOptions } from './launch.ts';

type AnyTool = Tool<any, any, any, any>;

/** The session a server runs for: its organization, Factory and card. */
export interface McpHubSession extends McpSessionScope {
  orgId: string;
  sessionId: string;
}

/** One server's state, as upstream mastracode's `McpServerStatus` reports it, plus each tool's risk. */
export interface McpServerStatus {
  connected: boolean;
  toolCount: number;
  tools: Array<McpToolInfo & { policy: McpToolPolicy; risk: McpToolRisk }>;
  /** Masked: no tokens, emails or addresses. */
  error?: string;
  errorKind?: McpErrorKind;
  checkedAt: string;
  /** Tools this check put under review (new, writing or destroying). */
  quarantined?: string[];
}

/** A tool call's outcome, for the page's «Спробувати». */
export interface McpToolTrial {
  ok: boolean;
  output?: unknown;
  error?: string;
  errorKind?: McpErrorKind;
  durationMs: number;
}

/** A tool «Спробувати» may not run: unknown, or not marked read-only by its server. */
export class McpToolNotTryableError extends Error {
  override name = 'McpToolNotTryableError';
  readonly reason: 'unknown_tool' | 'not_read_only';
  constructor(reason: 'unknown_tool' | 'not_read_only', message: string) {
    super(message);
    this.reason = reason;
  }
}

/**
 * Sorts a failure into a kind the page explains in the person's language (version mismatch, a
 * missing input, access denied, a time-out, a server that would not start).
 */
export function mcpErrorKind(message: string): McpErrorKind {
  if (/version/i.test(message) && /(install|mismatch|expected|pinned)/i.test(message)) return 'version_mismatch';
  if (/timed? ?out|ETIMEDOUT|deadline/i.test(message)) return 'timeout';
  if (/PERMISSION_DENIED|permission denied|forbidden|\b403\b|\b401\b|unauthori[sz]ed|access denied|insufficient/i.test(message)) {
    return 'auth_denied';
  }
  if (/missing|required|is not set|needs? (a|an|the) /i.test(message)) return 'missing_input';
  if (/ENOENT|EACCES|spawn|exited|Connection closed|not found in node_modules|failed to start/i.test(message)) return 'spawn_failed';
  return 'other';
}

/** A failure as the page and the stored health keep it: masked, short, with its kind. */
export function describeMcpFailure(error: unknown): { error: string; errorKind: McpErrorKind } {
  const raw = error instanceof Error ? error.message : String(error);
  return { error: redactText(raw).slice(0, 1_000), errorKind: mcpErrorKind(raw) };
}

/** A tool's annotations, as `MCPClient` keeps them on the Mastra tool (`mcp.annotations`). */
function toolAnnotations(tool: AnyTool): McpToolAnnotations | undefined {
  const annotations = (tool as { mcp?: { annotations?: McpToolAnnotations } }).mcp?.annotations;
  return annotations && typeof annotations === 'object' ? annotations : undefined;
}

/** A tool's input JSON Schema, when its converted schema still carries it. */
function toolInputSchema(tool: AnyTool): unknown {
  const schema = tool.inputSchema as
    | { jsonSchema?: unknown; toJSONSchema?: () => unknown; '~standard'?: { jsonSchema?: { input?: (o: unknown) => unknown } } }
    | undefined;
  if (!schema || typeof schema !== 'object') return undefined;
  try {
    if (schema.jsonSchema) return schema.jsonSchema;
    const standard = schema['~standard']?.jsonSchema?.input;
    if (typeof standard === 'function') return standard({ target: 'draft-07' });
    if (typeof schema.toJSONSchema === 'function') return schema.toJSONSchema();
  } catch {
    // A schema that cannot be described just isn't shown.
  }
  return undefined;
}

function toolInfo(name: string, tool: AnyTool): McpToolInfo {
  const annotations = toolAnnotations(tool);
  const inputSchema = toolInputSchema(tool);
  return {
    name,
    description: tool.description ?? '',
    ...(annotations ? { annotations } : {}),
    ...(inputSchema !== undefined ? { inputSchema } : {}),
  };
}

/** Fails a call that outlives the server's time limit (client side; the server may still be working). */
async function withTimeout<T>(run: () => Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)} s`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The `MCPClient` surface the hub uses; a test passes a stand-in. */
export interface McpClientLike {
  listToolsetsWithErrors(): Promise<{ toolsets: Record<string, Record<string, AnyTool>>; errors: Record<string, string> }>;
  disconnect(): Promise<void>;
}

export interface McpServerHubDeps {
  servers: {
    listRecords(orgId: string): Promise<McpServerRecord[]>;
    getRecord(orgId: string, id: string): Promise<McpServerRecord | null>;
    /** Keeps what a check found and puts new writing tools under review. */
    recordHealth?(orgId: string, id: string, health: McpServerHealth, quarantine?: readonly string[]): Promise<unknown>;
    /** Notes a session's use (and a failure's masked error). */
    recordUse?(orgId: string, id: string, at: Date, failure?: Pick<McpServerHealth, 'error' | 'errorKind'>): Promise<void>;
  };
  /** Each agent call to a server's tool: server, tool, session, outcome. Never arguments or results. */
  audit?: {
    record(input: {
      orgId: string;
      actorId: string;
      actorType: 'agent' | 'human';
      action: 'factory.mcp_server.tool_called' | 'factory.mcp_server.tool_tried';
      targets: Array<{ type: string; id: string; name?: string }>;
      metadata: Record<string, unknown>;
      factoryProjectId: string;
    }): Promise<unknown>;
  };
  createClient?: (servers: Record<string, unknown>) => McpClientLike;
  /** A session's servers stop after this long without a call; the next one starts them again. Default 15 min. */
  idleMs?: number;
  tempRoot?: string;
  log?: Pick<Console, 'warn'>;
  /** Reads an organization's account secret for a server filled from it (a Google Cloud key). */
  credentials?: { readSecret(orgId: string, ref: McpCredentialRef): Promise<string | null> };
  /** Brings the servers integrations manage in line with their settings before the first read per org. */
  managed?: { ensure(orgId: string): Promise<void> };
}

interface SessionServers {
  fingerprint: string;
  client: McpClientLike;
  prepared: PreparedMcpServer[];
  records: McpServerRecord[];
  toolsets: Record<string, Record<string, AnyTool>>;
  lastUsed: number;
}

function defaultClient(servers: Record<string, unknown>): McpClientLike {
  return new MCPClient({ id: `factory-mcp-${randomUUID()}`, servers: servers as never, timeout: 60_000 });
}

/**
 * Runs the organization's external MCP servers for agent sessions — the MCP manager. A session gets
 * the servers whose access covers its card (Factory, board, phase); they start with its first call
 * for tools and stop when it goes idle or the server shuts down: no process outlives its session.
 * Every tool passes through here: denied tools are never offered, `ask` tools wait for a person,
 * results are masked when the server says so, and each call is audited. Mastra sessions get the
 * tools in-process; Claude Code and Codex get the same tools from the Factory MCP endpoint.
 */
export class McpServerHub {
  readonly #deps: McpServerHubDeps;
  readonly #sessions = new Map<string, SessionServers>();
  readonly #starting = new Map<string, Promise<SessionServers | undefined>>();
  readonly #idleMs: number;
  /** Runs only while some session has servers running: an idle Factory holds no timer. */
  #sweep: NodeJS.Timeout | undefined;

  constructor(deps: McpServerHubDeps) {
    this.#deps = deps;
    this.#idleMs = deps.idleMs ?? 15 * 60_000;
  }

  /**
   * The session's MCP tools, named `server_tool`. `askSupported: false` (a harness with no way to
   * ask a person) leaves out `ask` tools rather than running them unasked.
   */
  async toolsFor(session: McpHubSession, options: { askSupported?: boolean } = {}): Promise<Record<string, AnyTool>> {
    const servers = await this.#serversFor(session);
    if (!servers) return {};
    servers.lastUsed = Date.now();
    const tools: Record<string, AnyTool> = {};
    for (const record of servers.records) {
      for (const [toolName, tool] of Object.entries(servers.toolsets[record.name] ?? {})) {
        const policy = mcpToolPolicy(record.toolPolicies, toolName);
        if (mcpToolHidden(policy) || (policy === 'ask' && options.askSupported === false)) continue;
        const name = mcpAgentToolName(record.name, toolName);
        tools[name] = this.#wrap(session, record, toolName, name, tool, policy, servers);
      }
    }
    return tools;
  }

  /** The session's tools a person must allow first (for a harness that asks through its own rules). */
  async askToolNames(session: McpHubSession): Promise<string[]> {
    const servers = await this.#serversFor(session);
    if (!servers) return [];
    return servers.records.flatMap(record =>
      Object.keys(servers.toolsets[record.name] ?? {})
        .filter(tool => mcpToolPolicy(record.toolPolicies, tool) === 'ask')
        .map(tool => mcpAgentToolName(record.name, tool)),
    );
  }

  /**
   * Starts the server on its own, lists its tools and stops it: the settings page's «Перевірити».
   * Keeps what it found with the server; a tool that is new since the last check and writes or
   * destroys goes under review (hidden from agents) until a person sets its policy.
   */
  async status(orgId: string, id: string): Promise<McpServerStatus | null> {
    const record = await this.#deps.servers.getRecord(orgId, id);
    if (!record) return null;
    const status = await this.check(orgId, record);
    if (!this.#deps.servers.recordHealth) return status;
    const tools: McpToolInfo[] = status.tools.map(({ policy: _policy, risk: _risk, ...info }) => info);
    const quarantine = status.connected ? mcpToolsToQuarantine(record.health?.tools, tools, record.toolPolicies) : [];
    const health: McpServerHealth = status.connected
      ? { state: 'ok', tools, checkedAt: status.checkedAt }
      : {
          state: /sign.?in|oauth|authenticate/i.test(status.error ?? '') ? 'needs_auth' : 'error',
          // A failed check keeps the tools the last good one saw, so quarantine still compares against them.
          tools: record.health?.tools ?? [],
          checkedAt: status.checkedAt,
          ...(status.error ? { error: status.error } : {}),
          ...(status.errorKind ? { errorKind: status.errorKind } : {}),
        };
    await this.#deps.servers.recordHealth(orgId, id, health, quarantine);
    if (!quarantine.length) return status;
    const quarantined = new Set(quarantine);
    return {
      ...status,
      quarantined: quarantine,
      tools: status.tools.map(tool => (quarantined.has(tool.name) ? { ...tool, policy: 'review' as const } : tool)),
    };
  }

  /**
   * Stops every running instance of a server (sessions start it again on their next call), then
   * checks it: the page's «Перепідключити», for a server stuck or changed outside the Factory.
   */
  async reconnect(orgId: string, id: string): Promise<McpServerStatus | null> {
    const using = [...this.#sessions.entries()].filter(([, entry]) =>
      entry.records.some(record => record.id === id && record.orgId === orgId),
    );
    await Promise.all(using.map(([sessionId]) => this.#close(sessionId)));
    return this.status(orgId, id);
  }

  /**
   * Runs one tool by itself with the given arguments — the page's «Спробувати». Only for a tool its
   * server marks read-only (`readOnlyHint`); the result is masked as the server says and audited.
   */
  async tryTool(orgId: string, id: string, toolName: string, args: unknown, actorId: string): Promise<McpToolTrial | null> {
    const record = await this.#deps.servers.getRecord(orgId, id);
    if (!record) return null;
    const started = Date.now();
    let prepared: PreparedMcpServer | undefined;
    let client: McpClientLike | undefined;
    try {
      prepared = await prepareMcpServer(record.launch, record.secrets, this.#prepareOptions(orgId));
      client = (this.#deps.createClient ?? defaultClient)({ [record.name]: prepared.definition });
      const { toolsets, errors } = await client.listToolsetsWithErrors();
      if (errors[record.name]) throw new Error(errors[record.name]);
      const tool = toolsets[record.name]?.[toolName];
      if (!tool?.execute) throw new McpToolNotTryableError('unknown_tool', `${record.label} has no tool "${toolName}".`);
      if (mcpToolRisk(toolAnnotations(tool)) !== 'read') {
        throw new McpToolNotTryableError('not_read_only', `"${toolName}" is not marked read-only by its server.`);
      }
      const output = await withTimeout(
        () => tool.execute!(args as never, {} as never),
        record.callTimeoutMs ?? DEFAULT_MCP_CALL_TIMEOUT_MS,
        `${record.label}: ${toolName}`,
      );
      void this.#auditTry(orgId, record, toolName, actorId, 'ok', Date.now() - started);
      return { ok: true, output: record.maskPersonalData ? redactDeep(output) : output, durationMs: Date.now() - started };
    } catch (error) {
      if (error instanceof McpToolNotTryableError) throw error;
      void this.#auditTry(orgId, record, toolName, actorId, 'error', Date.now() - started);
      return { ok: false, ...describeMcpFailure(error), durationMs: Date.now() - started };
    } finally {
      await client?.disconnect().catch(() => {});
      await prepared?.cleanup();
    }
  }

  /**
   * Starts a server from a config that need not be saved (the form's «Перевірити» before saving),
   * lists its tools and stops it. Nothing is stored; secret files are removed when it stops.
   */
  async check(orgId: string, record: Pick<McpServerRecord, 'name' | 'launch' | 'secrets' | 'toolPolicies'>): Promise<McpServerStatus> {
    const checkedAt = new Date().toISOString();
    let prepared: PreparedMcpServer | undefined;
    let client: McpClientLike | undefined;
    try {
      prepared = await prepareMcpServer(record.launch, record.secrets, this.#prepareOptions(orgId));
      client = (this.#deps.createClient ?? defaultClient)({ [record.name]: prepared.definition });
      const { toolsets, errors } = await client.listToolsetsWithErrors();
      const error = errors[record.name];
      const tools = Object.entries(toolsets[record.name] ?? {}).map(([name, tool]) => {
        const info = toolInfo(name, tool);
        return { ...info, policy: mcpToolPolicy(record.toolPolicies, name), risk: mcpToolRisk(info.annotations) };
      });
      return { connected: !error, toolCount: tools.length, tools, ...(error ? describeMcpFailure(error) : {}), checkedAt };
    } catch (error) {
      return { connected: false, toolCount: 0, tools: [], ...describeMcpFailure(error), checkedAt };
    } finally {
      await client?.disconnect().catch(() => {});
      await prepared?.cleanup();
    }
  }

  /** Stops every session's servers (server shutdown, tests). */
  async dispose(): Promise<void> {
    this.#stopSweep();
    await Promise.all([...this.#sessions.keys()].map(id => this.#close(id)));
  }

  /** Stops one session's servers (the session ended or was deleted). */
  async release(sessionId: string): Promise<void> {
    await this.#close(sessionId);
  }

  #prepareOptions(orgId: string): PrepareMcpServerOptions {
    const credentials = this.#deps.credentials;
    return {
      ...(this.#deps.tempRoot ? { tempRoot: this.#deps.tempRoot } : {}),
      ...(credentials ? { credentials: (ref: McpCredentialRef) => credentials.readSecret(orgId, ref) } : {}),
    };
  }

  async #serversFor(session: McpHubSession): Promise<SessionServers | undefined> {
    // A failed sync is logged loudly by `ensure`; the session keeps the servers as stored.
    await this.#deps.managed?.ensure(session.orgId).catch(() => undefined);
    const records = (await this.#deps.servers.listRecords(session.orgId)).filter(record => mcpServerAvailable(record, session));
    const fingerprint = records.map(record => `${record.id}@${record.updatedAt}`).join('|');
    const current = this.#sessions.get(session.sessionId);
    if (current?.fingerprint === fingerprint) return current;
    const pending = this.#starting.get(session.sessionId);
    if (pending) return pending;
    const starting = (async () => {
      await this.#close(session.sessionId);
      if (!records.length) return undefined;
      const prepared: PreparedMcpServer[] = [];
      const definitions: Record<string, unknown> = {};
      const ready: McpServerRecord[] = [];
      for (const record of records) {
        try {
          const server = await prepareMcpServer(record.launch, record.secrets, this.#prepareOptions(session.orgId));
          prepared.push(server);
          definitions[record.name] = server.definition;
          ready.push(record);
        } catch (error) {
          this.#warn(record, error);
        }
      }
      if (!ready.length) {
        await Promise.all(prepared.map(server => server.cleanup()));
        return undefined;
      }
      const client = (this.#deps.createClient ?? defaultClient)(definitions);
      const { toolsets, errors } = await client.listToolsetsWithErrors();
      for (const [name, error] of Object.entries(errors)) {
        this.#warn(ready.find(record => record.name === name) ?? { name }, error);
      }
      const entry: SessionServers = { fingerprint, client, prepared, records: ready, toolsets, lastUsed: Date.now() };
      this.#sessions.set(session.sessionId, entry);
      this.#sweep ??= setInterval(() => void this.#evictIdle(this.#idleMs), Math.min(this.#idleMs, 60_000));
      this.#sweep.unref();
      return entry;
    })().finally(() => this.#starting.delete(session.sessionId));
    this.#starting.set(session.sessionId, starting);
    return starting;
  }

  #wrap(
    session: McpHubSession,
    record: McpServerRecord,
    toolName: string,
    name: string,
    tool: AnyTool,
    policy: McpToolPolicy,
    servers: SessionServers,
  ): AnyTool {
    return createTool({
      id: name,
      description: `${record.label}: ${tool.description ?? toolName}`,
      ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
      ...(policy === 'ask' ? { requireApproval: true } : {}),
      execute: async (input: unknown, context: unknown) => {
        servers.lastUsed = Date.now();
        const started = Date.now();
        try {
          const output = await withTimeout(
            () => tool.execute!(input as never, context as never),
            record.callTimeoutMs ?? DEFAULT_MCP_CALL_TIMEOUT_MS,
            `${record.label}: ${toolName}`,
          );
          void this.#audit(session, record, toolName, 'ok', Date.now() - started);
          void this.#noteUse(session.orgId, record);
          return record.maskPersonalData ? redactDeep(output) : output;
        } catch (error) {
          void this.#audit(session, record, toolName, 'error', Date.now() - started);
          void this.#noteUse(session.orgId, record, describeMcpFailure(error));
          throw error;
        }
      },
    }) as AnyTool;
  }

  async #audit(
    session: McpHubSession,
    record: McpServerRecord,
    tool: string,
    outcome: 'ok' | 'error',
    durationMs: number,
  ): Promise<void> {
    try {
      await this.#deps.audit?.record({
        orgId: session.orgId,
        actorId: session.sessionId,
        actorType: 'agent',
        action: 'factory.mcp_server.tool_called',
        targets: [{ type: 'mcp_server', id: record.id, name: record.label }],
        metadata: { server: record.name, tool, sessionId: session.sessionId, outcome, durationMs },
        factoryProjectId: session.factoryProjectId,
      });
    } catch (error) {
      this.#deps.log?.warn?.('[mcp-servers] Could not audit a tool call', error);
    }
  }

  async #auditTry(
    orgId: string,
    record: McpServerRecord,
    tool: string,
    actorId: string,
    outcome: 'ok' | 'error',
    durationMs: number,
  ): Promise<void> {
    try {
      await this.#deps.audit?.record({
        orgId,
        actorId,
        actorType: 'human',
        action: 'factory.mcp_server.tool_tried',
        targets: [{ type: 'mcp_server', id: record.id, name: record.label }],
        metadata: { server: record.name, tool, outcome, durationMs },
        factoryProjectId: record.assignments[0]?.factoryProjectId ?? '',
      });
    } catch (error) {
      this.#deps.log?.warn?.('[mcp-servers] Could not audit a tried tool', error);
    }
  }

  /** Successful uses are kept at most once a minute per server; failures always. */
  readonly #lastNoted = new Map<string, number>();

  async #noteUse(orgId: string, record: McpServerRecord, failure?: { error: string; errorKind: McpErrorKind }): Promise<void> {
    const now = Date.now();
    if (!failure && now - (this.#lastNoted.get(record.id) ?? 0) < 60_000) return;
    this.#lastNoted.set(record.id, now);
    try {
      await this.#deps.servers.recordUse?.(orgId, record.id, new Date(now), failure);
    } catch (error) {
      this.#deps.log?.warn?.('[mcp-servers] Could not note a server use', error);
    }
  }

  #warn(record: { name: string; id?: string; orgId?: string }, error: unknown): void {
    const failure = describeMcpFailure(error);
    (this.#deps.log ?? console).warn(`[mcp-servers] Server "${record.name}" is unavailable to this session: ${failure.error}`);
    if (record.id && record.orgId) {
      void this.#deps.servers.recordUse?.(record.orgId, record.id, new Date(), failure).catch(() => undefined);
    }
  }

  async #evictIdle(idleMs: number): Promise<void> {
    const now = Date.now();
    for (const [id, entry] of this.#sessions) if (now - entry.lastUsed > idleMs) await this.#close(id);
  }

  #stopSweep(): void {
    if (this.#sweep) clearInterval(this.#sweep);
    this.#sweep = undefined;
  }

  async #close(sessionId: string): Promise<void> {
    const entry = this.#sessions.get(sessionId);
    if (!entry) return;
    this.#sessions.delete(sessionId);
    if (this.#sessions.size === 0) this.#stopSweep();
    await entry.client.disconnect().catch(() => {});
    await Promise.all(entry.prepared.map(server => server.cleanup()));
  }
}
