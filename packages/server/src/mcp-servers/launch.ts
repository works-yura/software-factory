import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { mcpCatalogVariant } from '@factory/core';
import type { McpCredentialRef, McpServerLaunch, McpServerSecrets } from '@factory/core';

import { catalogEntrypoint, mcpCatalogEntryById } from './catalog.ts';

/** What `MCPClient` takes for one server (upstream Mastra's stdio / http definitions). */
export type McpClientServerDefinition =
  | { command: string; args: string[]; env: Record<string, string> }
  | { url: URL; requestInit: { headers: Record<string, string> } };

export interface PreparedMcpServer {
  definition: McpClientServerDefinition;
  /** Removes the secret files written for this launch. Safe to call twice. */
  cleanup: () => Promise<void>;
}

/** A misconfigured server: shown in its status and the session's tool error, never silently skipped. */
export class McpServerLaunchError extends Error {
  override name = 'McpServerLaunchError';
}

/** Reads the secret of an account the organization keeps (a Google Cloud key), for one launch. */
export type McpCredentialReader = (ref: McpCredentialRef) => Promise<string | null>;

export interface PrepareMcpServerOptions {
  tempRoot?: string;
  baseEnv?: NodeJS.ProcessEnv;
  credentials?: McpCredentialReader;
}

const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** `${VAR}` in an argument from the launch's own values (upstream mastracode's `expandEnvVars`), never the host's. */
function expand(value: string, values: Record<string, string>): string {
  return value.replace(PLACEHOLDER, (_, name: string) => {
    const resolved = values[name];
    if (resolved === undefined) throw new McpServerLaunchError(`Argument needs ${name}, which this server does not set.`);
    return resolved;
  });
}

/** A private folder (0700) for one launch's secret files (0600), removed by `cleanup`. */
class SecretFiles {
  #folder: string | undefined;
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
  }

  async write(name: string, content: string): Promise<string> {
    this.#folder ??= await mkdtemp(join(this.#root, 'factory-mcp-'));
    const path = join(this.#folder, name.toLowerCase());
    await writeFile(path, content, { mode: 0o600 });
    return path;
  }

  async cleanup(): Promise<void> {
    if (!this.#folder) return;
    const removing = this.#folder;
    this.#folder = undefined;
    await rm(removing, { recursive: true, force: true });
  }
}

function hostBase(options: PrepareMcpServerOptions): Record<string, string> {
  const base = options.baseEnv ?? process.env;
  return { ...(base.PATH ? { PATH: base.PATH } : {}), ...(base.HOME ? { HOME: base.HOME } : {}) };
}

/**
 * Turns a stored server into an `MCPClient` definition. Secret files (a key, a tools file) are
 * written to a private folder whose paths the server gets; `cleanup` deletes it. A local server sees
 * only its own variables plus PATH/HOME, not the Factory server's environment.
 */
export async function prepareMcpServer(
  launch: McpServerLaunch,
  secrets: McpServerSecrets,
  options: PrepareMcpServerOptions = {},
): Promise<PreparedMcpServer> {
  if (launch.transport === 'http') {
    return {
      definition: { url: new URL(launch.url), requestInit: { headers: { ...launch.headers, ...secrets.headers } } },
      cleanup: async () => {},
    };
  }
  if (launch.transport === 'stdio' && launch.preset) {
    throw new McpServerLaunchError(`This server still uses the retired preset "${launch.preset}"; the boot migration moves it to the catalog.`);
  }

  const files = new SecretFiles(options.tempRoot ?? tmpdir());
  try {
    if (launch.transport === 'stdio') {
      if (!launch.command) throw new McpServerLaunchError('A local server needs a command.');
      const env: Record<string, string> = { ...hostBase(options), ...launch.env, ...secrets.env };
      for (const [name, content] of Object.entries(secrets.files)) env[name] = await files.write(name, content);
      return {
        definition: { command: expand(launch.command, env), args: launch.args.map(arg => expand(arg, env)), env },
        cleanup: () => files.cleanup(),
      };
    }

    const entry = mcpCatalogEntryById(launch.entry);
    if (!entry) throw new McpServerLaunchError(`The catalog has no server "${launch.entry}".`);
    const variant = mcpCatalogVariant(entry, launch.variant);
    if (!variant) throw new McpServerLaunchError(`${entry.label.en}: choose one of ${entry.variants.map(v => v.id).join(', ')}.`);

    const values: Record<string, string> = {};
    const env: Record<string, string> = hostBase(options);
    for (const field of variant.fields) {
      let value: string | undefined;
      const ref = launch.credentials[field.key];
      if (ref) {
        if (!options.credentials) throw new McpServerLaunchError(`${field.label.en} needs an account, and none can be read here.`);
        const secret = await options.credentials(ref);
        if (secret === null) throw new McpServerLaunchError(`${field.label.en}: the chosen account no longer exists.`);
        value = field.file ? await files.write(field.key, secret) : secret;
      } else if (field.file) {
        const content = secrets.files[field.key];
        if (content !== undefined) value = await files.write(field.key, content);
      } else {
        value = (field.secret ? secrets.env[field.key] : launch.inputs[field.key]) ?? field.default;
      }
      if (value === undefined || (field.required && value === '')) {
        if (field.required) throw new McpServerLaunchError(`${field.label.en} (${field.key}) is required.`);
        continue;
      }
      values[field.key] = value;
      if (field.kind === 'env') env[field.key] = value;
    }
    const args = variant.args.map(arg => expand(arg, values));
    return {
      definition: { command: process.execPath, args: [catalogEntrypoint(entry), ...args], env },
      cleanup: () => files.cleanup(),
    };
  } catch (error) {
    await files.cleanup();
    throw error;
  }
}
