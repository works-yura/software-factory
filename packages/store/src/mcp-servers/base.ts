import { FactoryStorageDomain, UniqueViolationError } from '@mastra/core/storage';
import type { CollectionSchema, FactoryStorageOps } from '@mastra/core/storage';

import { DEFAULT_MCP_TOOL_POLICIES, mcpServerLaunchSchema, mcpServerSecretsSchema } from '@factory/core';
import type {
  McpServerAssignment,
  McpServerInput,
  McpServerLaunch,
  McpServerSecrets,
  McpServerView,
  McpToolPolicies,
} from '@factory/core';

import { createPlaintextFactorySecretEncryption } from '../secret-encryption.ts';
import type { FactorySecretEncryption } from '../secret-encryption.ts';

/** A server with its decrypted secrets: only the hub that launches it reads this. */
export interface McpServerRecord extends McpServerView {
  orgId: string;
  secrets: McpServerSecrets;
}

const SERVERS = 'factory_mcp_servers';

export const MCP_SERVERS_SCHEMA: CollectionSchema = {
  name: SERVERS,
  columns: {
    id: { type: 'uuid-pk' },
    org_id: { type: 'text' },
    name: { type: 'text' },
    label: { type: 'text' },
    launch: { type: 'json' },
    /** Encrypted `McpServerSecrets` JSON; never leaves this domain except decrypted to the hub. */
    secrets: { type: 'text' },
    assignments: { type: 'json' },
    tool_policies: { type: 'json' },
    mask_personal_data: { type: 'boolean' },
    enabled: { type: 'boolean' },
    created_by: { type: 'text' },
    updated_by: { type: 'text' },
    created_at: { type: 'timestamp' },
    updated_at: { type: 'timestamp' },
  },
  uniqueIndexes: [{ name: 'factory_mcp_servers_org_name_key', columns: ['org_id', 'name'] }],
};

interface McpServerDbRow extends Record<string, unknown> {
  id: string;
  org_id: string;
  name: string;
  label: string;
  launch: unknown;
  secrets: string;
  assignments: unknown;
  tool_policies: unknown;
  mask_personal_data: boolean;
  enabled: boolean;
  created_by: string;
  updated_by: string;
  created_at: Date;
  updated_at: Date;
}

/** A server name already taken in the organization. */
export class McpServerNameTakenError extends Error {
  override name = 'McpServerNameTakenError';
}

const EMPTY_SECRETS: McpServerSecrets = { env: {}, headers: {}, files: {} };

/** Applies a write's secrets onto the stored ones: a value sets, `null` removes, absent keeps. */
export function mergeMcpSecrets(current: McpServerSecrets, change: McpServerInput['secrets']): McpServerSecrets {
  const next: McpServerSecrets = { env: { ...current.env }, headers: { ...current.headers }, files: { ...current.files } };
  for (const kind of ['env', 'headers', 'files'] as const) {
    for (const [key, value] of Object.entries(change?.[kind] ?? {})) {
      if (value === null) delete next[kind][key];
      else next[kind][key] = value;
    }
  }
  return next;
}

/**
 * The organization's external MCP servers (upstream Mastra's stored MCP clients, `mcp-clients`),
 * with the Factory's additions: secrets encrypted apart from the config, which Factories' cards get
 * each server, and each tool's policy. Secrets are written, never read back by the API.
 */
export class McpServersStorage extends FactoryStorageDomain {
  readonly #encryption: FactorySecretEncryption;

  constructor(encryption: FactorySecretEncryption = createPlaintextFactorySecretEncryption()) {
    super('mcp-servers');
    this.#encryption = encryption;
  }

  async init(): Promise<void> {
    await this.ensureCollections([MCP_SERVERS_SCHEMA]);
    // Re-encrypt secrets saved as plaintext or under a retired key, like the other secret domains.
    const rows = await this.#db.findMany<McpServerDbRow>(SERVERS, {});
    await Promise.all(
      rows.map(({ id }) =>
        this.#db.updateAtomic<McpServerDbRow>(SERVERS, { id }, async row => {
          const decrypted = await this.#encryption.decrypt<McpServerSecrets>(row.secrets);
          return decrypted.needsReencryption ? { secrets: await this.#encryption.encrypt(decrypted.value) } : null;
        }),
      ),
    );
  }

  async dangerouslyClearAll(): Promise<void> {
    await this.ops.deleteMany(SERVERS, {});
  }

  get #db(): FactoryStorageOps {
    return this.ops;
  }

  async list(orgId: string): Promise<McpServerView[]> {
    const rows = await this.#db.findMany<McpServerDbRow>(SERVERS, { org_id: orgId }, { orderBy: [['name', 'asc']] });
    return Promise.all(rows.map(row => this.#view(row)));
  }

  async get(orgId: string, id: string): Promise<McpServerView | null> {
    const row = await this.#db.findOne<McpServerDbRow>(SERVERS, { org_id: orgId, id });
    return row ? this.#view(row) : null;
  }

  /** The servers with secrets, for launching. */
  async listRecords(orgId: string): Promise<McpServerRecord[]> {
    const rows = await this.#db.findMany<McpServerDbRow>(SERVERS, { org_id: orgId }, { orderBy: [['name', 'asc']] });
    return Promise.all(rows.map(row => this.#record(row)));
  }

  async getRecord(orgId: string, id: string): Promise<McpServerRecord | null> {
    const row = await this.#db.findOne<McpServerDbRow>(SERVERS, { org_id: orgId, id });
    return row ? this.#record(row) : null;
  }

  async create(orgId: string, input: McpServerInput, actorId: string): Promise<McpServerView> {
    const now = new Date();
    try {
      const row = await this.#db.insertOne<McpServerDbRow>(SERVERS, {
        org_id: orgId,
        name: input.name,
        label: input.label,
        launch: input.launch,
        secrets: await this.#encryption.encrypt(mergeMcpSecrets(EMPTY_SECRETS, input.secrets)),
        assignments: input.assignments,
        tool_policies: input.toolPolicies,
        mask_personal_data: input.maskPersonalData,
        enabled: input.enabled,
        created_by: actorId,
        updated_by: actorId,
        created_at: now,
        updated_at: now,
      });
      return this.#view(row);
    } catch (error) {
      if (error instanceof UniqueViolationError) throw new McpServerNameTakenError(`MCP server "${input.name}" already exists.`);
      throw error;
    }
  }

  async update(orgId: string, id: string, input: McpServerInput, actorId: string): Promise<McpServerView | null> {
    const now = new Date();
    try {
      const row = await this.#db.updateAtomic<McpServerDbRow>(SERVERS, { org_id: orgId, id }, async current => {
        const secrets = mergeMcpSecrets((await this.#encryption.decrypt<McpServerSecrets>(current.secrets)).value, input.secrets);
        return {
          name: input.name,
          label: input.label,
          launch: input.launch,
          secrets: await this.#encryption.encrypt(secrets),
          assignments: input.assignments,
          tool_policies: input.toolPolicies,
          mask_personal_data: input.maskPersonalData,
          enabled: input.enabled,
          updated_by: actorId,
          updated_at: now,
        };
      });
      return row ? this.#view(row) : null;
    } catch (error) {
      if (error instanceof UniqueViolationError) throw new McpServerNameTakenError(`MCP server "${input.name}" already exists.`);
      throw error;
    }
  }

  /**
   * Rewrites stored launches across every organization (a boot migration): `change` returns the new
   * launch and secrets, or `null` to leave a row as it is. Returns how many rows changed.
   */
  async rewriteLaunches(
    change: (row: { launch: McpServerLaunch; secrets: McpServerSecrets }) => { launch: McpServerLaunch; secrets: McpServerSecrets } | null,
  ): Promise<number> {
    const rows = await this.#db.findMany<McpServerDbRow>(SERVERS, {});
    let changed = 0;
    for (const { id } of rows) {
      let wrote = false;
      await this.#db.updateAtomic<McpServerDbRow>(SERVERS, { id }, async row => {
        const next = change({ launch: mcpServerLaunchSchema.parse(row.launch) as McpServerLaunch, secrets: await this.#secrets(row) });
        if (!next) return null;
        wrote = true;
        return { launch: next.launch, secrets: await this.#encryption.encrypt(next.secrets) };
      });
      if (wrote) changed += 1;
    }
    return changed;
  }

  async delete(orgId: string, id: string): Promise<boolean> {
    return (await this.#db.deleteMany(SERVERS, { org_id: orgId, id })) > 0;
  }

  async #secrets(row: McpServerDbRow): Promise<McpServerSecrets> {
    const { value } = await this.#encryption.decrypt<McpServerSecrets>(row.secrets);
    return mcpServerSecretsSchema.parse(value ?? EMPTY_SECRETS);
  }

  async #view(row: McpServerDbRow): Promise<McpServerView> {
    const secrets = await this.#secrets(row);
    return {
      id: row.id,
      name: row.name,
      label: row.label,
      launch: mcpServerLaunchSchema.parse(row.launch) as McpServerLaunch,
      secretNames: {
        env: Object.keys(secrets.env).sort(),
        headers: Object.keys(secrets.headers).sort(),
        files: Object.keys(secrets.files).sort(),
      },
      assignments: (row.assignments as McpServerAssignment[] | null) ?? [],
      toolPolicies: (row.tool_policies as McpToolPolicies | null) ?? DEFAULT_MCP_TOOL_POLICIES,
      maskPersonalData: row.mask_personal_data !== false,
      enabled: row.enabled !== false,
      updatedAt: new Date(row.updated_at).toISOString(),
      updatedBy: row.updated_by,
    };
  }

  async #record(row: McpServerDbRow): Promise<McpServerRecord> {
    return { ...(await this.#view(row)), orgId: row.org_id, secrets: await this.#secrets(row) };
  }
}
