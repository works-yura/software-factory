import type { McpServerLaunch, McpServerSecrets } from '@factory/core';

/**
 * Servers saved with the first version's built-in presets (`toolbox-firestore`, `toolbox`) become
 * catalog launches of «База даних (MCP Toolbox)». A pasted key keeps working: it stays a secret
 * file under the same input, which a person can later swap for one of the organization's Google
 * Cloud accounts. Anything else is left as it is.
 */
export function presetToCatalogLaunch(row: {
  launch: McpServerLaunch;
  secrets: McpServerSecrets;
}): { launch: McpServerLaunch; secrets: McpServerSecrets } | null {
  const { launch, secrets } = row;
  if (launch.transport !== 'stdio' || !launch.preset) return null;
  if (launch.preset === 'toolbox-firestore') {
    const inputs = Object.fromEntries(
      (['FIRESTORE_PROJECT', 'FIRESTORE_DATABASE'] as const).flatMap(name =>
        launch.env[name] !== undefined ? [[name, launch.env[name]!]] : [],
      ),
    );
    const key = secrets.files.GOOGLE_APPLICATION_CREDENTIALS;
    const files: Record<string, string> = key ? { GOOGLE_APPLICATION_CREDENTIALS: key } : {};
    return {
      launch: { transport: 'catalog', entry: 'mcp-toolbox', variant: 'firestore', inputs, credentials: {} },
      secrets: { env: {}, headers: {}, files },
    };
  }
  if (launch.preset === 'toolbox') {
    const toolsFile = secrets.files.TOOLBOX_TOOLS_FILE;
    return {
      launch: { transport: 'catalog', entry: 'mcp-toolbox', variant: 'tools-file', inputs: {}, credentials: {} },
      secrets: { env: {}, headers: {}, files: toolsFile ? { tools_file: toolsFile } : {} },
    };
  }
  throw new Error(`MCP server preset "${launch.preset}" has no catalog entry to move to.`);
}
