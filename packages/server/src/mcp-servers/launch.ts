import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { McpServerLaunch, McpServerSecrets } from '@factory/core';

import { mcpServerPreset, presetEntrypoint } from './presets.ts';

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

const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** `${VAR}` in an argument from the launch's own variables (upstream mastracode's `expandEnvVars`), never the host's. */
function expand(value: string, env: Record<string, string>): string {
  return value.replace(PLACEHOLDER, (_, name: string) => {
    const resolved = env[name];
    if (resolved === undefined) throw new McpServerLaunchError(`Argument needs ${name}, which this server does not set.`);
    return resolved;
  });
}

/**
 * Turns a stored server into an `MCPClient` definition. Secret files are written to a private
 * folder (0700, files 0600) whose paths go into their variables; `cleanup` deletes it. A stdio
 * server sees only its own variables plus PATH/HOME, not the Factory server's environment.
 */
export async function prepareMcpServer(
  launch: McpServerLaunch,
  secrets: McpServerSecrets,
  options: { tempRoot?: string; baseEnv?: NodeJS.ProcessEnv } = {},
): Promise<PreparedMcpServer> {
  if (launch.transport === 'http') {
    return {
      definition: { url: new URL(launch.url), requestInit: { headers: { ...launch.headers, ...secrets.headers } } },
      cleanup: async () => {},
    };
  }

  const preset = launch.preset ? mcpServerPreset(launch.preset) : undefined;
  if (launch.preset && !preset) throw new McpServerLaunchError(`Unknown preset "${launch.preset}".`);
  if (!preset && !launch.command) throw new McpServerLaunchError('A stdio server needs a command or a preset.');
  for (const required of preset?.env.filter(entry => entry.required) ?? []) {
    if (!launch.env[required.name] && !secrets.env[required.name]) {
      throw new McpServerLaunchError(`${required.name} is required (${required.label}).`);
    }
  }
  for (const required of preset?.secretFiles.filter(entry => entry.required) ?? []) {
    if (!secrets.files[required.name]) throw new McpServerLaunchError(`${required.name} is required (${required.label}).`);
  }

  let folder: string | undefined;
  const cleanup = async () => {
    if (!folder) return;
    const removing = folder;
    folder = undefined;
    await rm(removing, { recursive: true, force: true });
  };
  const fileEnv: Record<string, string> = {};
  try {
    const names = Object.keys(secrets.files);
    if (names.length) {
      folder = await mkdtemp(join(options.tempRoot ?? tmpdir(), 'factory-mcp-'));
      for (const name of names) {
        const path = join(folder, name.toLowerCase());
        await writeFile(path, secrets.files[name]!, { mode: 0o600 });
        fileEnv[name] = path;
      }
    }
    const base = options.baseEnv ?? process.env;
    const env: Record<string, string> = {
      ...(base.PATH ? { PATH: base.PATH } : {}),
      ...(base.HOME ? { HOME: base.HOME } : {}),
      ...launch.env,
      ...secrets.env,
      ...fileEnv,
    };
    const presetArgs = preset ? preset.args : [];
    const args = [...presetArgs, ...launch.args].map(arg => expand(arg, env));
    const definition = preset
      ? { command: process.execPath, args: [presetEntrypoint(preset), ...args], env }
      : { command: expand(launch.command!, env), args, env };
    return { definition, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
