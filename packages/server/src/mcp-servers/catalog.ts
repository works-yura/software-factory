import { createRequire } from 'node:module';

import { mcpCatalogEntry } from '@factory/core';
import type { McpCatalogEntry } from '@factory/core';

import toolboxOverlay from './catalog/mcp-toolbox.factory.json' with { type: 'json' };
import toolboxManifest from './catalog/mcp-toolbox.server.json' with { type: 'json' };

/**
 * The MCP servers the Factory ships: each an MCP Registry `server.json` plus its Factory overlay,
 * as data under `./catalog/`. Its package is a pinned dependency of this package, so nothing is
 * fetched at run time (`npx` of a moving version never runs here); a manifest whose version is not
 * the installed one fails the launch loudly.
 */
export const MCP_CATALOG: readonly McpCatalogEntry[] = [mcpCatalogEntry(toolboxManifest, toolboxOverlay)];

export function mcpCatalogEntryById(id: string): McpCatalogEntry | undefined {
  return MCP_CATALOG.find(entry => entry.id === id);
}

const require = createRequire(import.meta.url);

/** The installed launcher of a catalog entry's package; throws on a missing or different version. */
export function catalogEntrypoint(entry: McpCatalogEntry): string {
  const manifestPath = require.resolve(`${entry.package.identifier}/package.json`);
  const installed = (require(manifestPath) as { version?: string }).version;
  if (installed !== entry.package.version) {
    throw new Error(
      `${entry.package.identifier} ${installed ?? '(unknown)'} is installed, but the catalog pins ${entry.package.version}.`,
    );
  }
  return manifestPath.replace(/package\.json$/, entry.package.entrypoint);
}
