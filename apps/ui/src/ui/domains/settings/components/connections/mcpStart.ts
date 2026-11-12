import type { McpCatalogEntry } from '@factory/core';

import type { McpServerStart } from '../mcp-servers/McpServerEditor';
import type { McpServer } from '../../services/mcpServers';

/** Where a stored server starts its form from: its catalog entry, or an own server. */
export function mcpStartOf(server: McpServer, catalog: readonly McpCatalogEntry[]): McpServerStart {
  const entry = server.launch.transport === 'catalog' ? catalog.find(candidate => candidate.id === (server.launch as { entry: string }).entry) : undefined;
  return entry ? { kind: 'catalog', entry } : { kind: 'custom' };
}
