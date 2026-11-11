import type { ManagedMcpServerSpec } from '@factory/core';
import type { McpServersStorage } from '@factory/store';

/** An integration that runs MCP servers under the hood (Google Cloud's «База» is MCP Toolbox). */
export interface McpServerManagingIntegration {
  readonly id: string;
  managedMcpServers(orgId: string): Promise<ManagedMcpServerSpec[]>;
}

interface Logger {
  error(message: string, meta?: Record<string, unknown>): void;
}

/**
 * Keeps the MCP servers integrations manage in step with their settings: after an integration's
 * settings change (its route calls `sync`), and once per organization per boot before the servers
 * are read (`ensure`) — the store has no list of organizations, so the first read after a boot is
 * when an organization's servers are brought in line. Idempotent: a sync with nothing changed
 * writes nothing.
 */
export class ManagedMcpServers {
  readonly #servers: Pick<McpServersStorage, 'syncOwned'>;
  readonly #integrations: () => readonly McpServerManagingIntegration[];
  readonly #logger: Logger | undefined;
  readonly #ensured = new Map<string, Promise<void>>();

  constructor(deps: {
    servers: Pick<McpServersStorage, 'syncOwned'>;
    /** Read on each call: integrations are ready only after this is built. */
    integrations: () => readonly McpServerManagingIntegration[];
    logger?: Logger;
  }) {
    this.#servers = deps.servers;
    this.#integrations = deps.integrations;
    this.#logger = deps.logger;
  }

  /** Brings every managing integration's servers in the organization in line with its settings. */
  async sync(orgId: string): Promise<void> {
    for (const integration of this.#integrations()) {
      const specs = await integration.managedMcpServers(orgId);
      await this.#servers.syncOwned(orgId, integration.id, specs, `integration:${integration.id}`);
    }
    this.#ensured.set(orgId, Promise.resolve());
  }

  /**
   * Syncs the organization once per boot. A failure is logged loudly and retried on the next read
   * (the stored servers stay as they were), then rethrown so the caller can show it.
   */
  ensure(orgId: string): Promise<void> {
    const current = this.#ensured.get(orgId);
    if (current) return current;
    const run = this.sync(orgId).catch(error => {
      this.#ensured.delete(orgId);
      this.#logger?.error('[mcp-servers] could not sync the servers integrations manage', {
        orgId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    });
    this.#ensured.set(orgId, run);
    return run;
  }
}
