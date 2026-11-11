import { randomUUID } from 'node:crypto';

import { MCPClient } from '@mastra/mcp';
import { createTool } from '@mastra/core/tools';
import type { Tool } from '@mastra/core/tools';

import { redactDeep } from '@factory/capabilities';
import { mcpAgentToolName, mcpServerAvailable, mcpToolPolicy } from '@factory/core';
import type { McpSessionScope, McpToolPolicy } from '@factory/core';
import type { McpServerRecord } from '@factory/store';

import { prepareMcpServer } from './launch.ts';
import type { PreparedMcpServer } from './launch.ts';

type AnyTool = Tool<any, any, any, any>;

/** The session a server runs for: its organization, Factory and card. */
export interface McpHubSession extends McpSessionScope {
  orgId: string;
  sessionId: string;
}

/** One server's state, as upstream mastracode's `McpServerStatus` reports it. */
export interface McpServerStatus {
  connected: boolean;
  toolCount: number;
  tools: Array<{ name: string; description: string; policy: McpToolPolicy }>;
  error?: string;
  checkedAt: string;
}

/** The `MCPClient` surface the hub uses; a test passes a stand-in. */
export interface McpClientLike {
  listToolsetsWithErrors(): Promise<{ toolsets: Record<string, Record<string, AnyTool>>; errors: Record<string, string> }>;
  disconnect(): Promise<void>;
}

export interface McpServerHubDeps {
  servers: { listRecords(orgId: string): Promise<McpServerRecord[]>; getRecord(orgId: string, id: string): Promise<McpServerRecord | null> };
  /** Each agent call to a server's tool: server, tool, session, outcome. Never arguments or results. */
  audit?: {
    record(input: {
      orgId: string;
      actorId: string;
      actorType: 'agent';
      action: 'factory.mcp_server.tool_called';
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
  readonly #sweep: NodeJS.Timeout;

  constructor(deps: McpServerHubDeps) {
    this.#deps = deps;
    const idleMs = deps.idleMs ?? 15 * 60_000;
    this.#sweep = setInterval(() => void this.#evictIdle(idleMs), Math.min(idleMs, 60_000));
    this.#sweep.unref();
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
        if (policy === 'deny' || (policy === 'ask' && options.askSupported === false)) continue;
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

  /** Starts the server on its own, lists its tools and stops it: the settings page's «Перевірити». */
  async status(orgId: string, id: string): Promise<McpServerStatus | null> {
    const record = await this.#deps.servers.getRecord(orgId, id);
    if (!record) return null;
    const checkedAt = new Date().toISOString();
    let prepared: PreparedMcpServer | undefined;
    let client: McpClientLike | undefined;
    try {
      prepared = await prepareMcpServer(record.launch, record.secrets, this.#tempOptions());
      client = (this.#deps.createClient ?? defaultClient)({ [record.name]: prepared.definition });
      const { toolsets, errors } = await client.listToolsetsWithErrors();
      const error = errors[record.name];
      const tools = Object.entries(toolsets[record.name] ?? {}).map(([name, tool]) => ({
        name,
        description: tool.description ?? '',
        policy: mcpToolPolicy(record.toolPolicies, name),
      }));
      return { connected: !error, toolCount: tools.length, tools, ...(error ? { error } : {}), checkedAt };
    } catch (error) {
      return { connected: false, toolCount: 0, tools: [], error: error instanceof Error ? error.message : String(error), checkedAt };
    } finally {
      await client?.disconnect().catch(() => {});
      await prepared?.cleanup();
    }
  }

  /** Stops every session's servers (server shutdown, tests). */
  async dispose(): Promise<void> {
    clearInterval(this.#sweep);
    await Promise.all([...this.#sessions.keys()].map(id => this.#close(id)));
  }

  /** Stops one session's servers (the session ended or was deleted). */
  async release(sessionId: string): Promise<void> {
    await this.#close(sessionId);
  }

  #tempOptions() {
    return this.#deps.tempRoot ? { tempRoot: this.#deps.tempRoot } : {};
  }

  async #serversFor(session: McpHubSession): Promise<SessionServers | undefined> {
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
          const server = await prepareMcpServer(record.launch, record.secrets, this.#tempOptions());
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
        try {
          const output = await tool.execute!(input as never, context as never);
          void this.#audit(session, record, toolName, 'ok');
          return record.maskPersonalData ? redactDeep(output) : output;
        } catch (error) {
          void this.#audit(session, record, toolName, 'error');
          throw error;
        }
      },
    }) as AnyTool;
  }

  async #audit(session: McpHubSession, record: McpServerRecord, tool: string, outcome: 'ok' | 'error'): Promise<void> {
    try {
      await this.#deps.audit?.record({
        orgId: session.orgId,
        actorId: session.sessionId,
        actorType: 'agent',
        action: 'factory.mcp_server.tool_called',
        targets: [{ type: 'mcp_server', id: record.id, name: record.label }],
        metadata: { server: record.name, tool, sessionId: session.sessionId, outcome },
        factoryProjectId: session.factoryProjectId,
      });
    } catch (error) {
      this.#deps.log?.warn?.('[mcp-servers] Could not audit a tool call', error);
    }
  }

  #warn(record: { name: string }, error: unknown): void {
    (this.#deps.log ?? console).warn(
      `[mcp-servers] Server "${record.name}" is unavailable to this session: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  async #evictIdle(idleMs: number): Promise<void> {
    const now = Date.now();
    for (const [id, entry] of this.#sessions) if (now - entry.lastUsed > idleMs) await this.#close(id);
  }

  async #close(sessionId: string): Promise<void> {
    const entry = this.#sessions.get(sessionId);
    if (!entry) return;
    this.#sessions.delete(sessionId);
    await entry.client.disconnect().catch(() => {});
    await Promise.all(entry.prepared.map(server => server.cleanup()));
  }
}
