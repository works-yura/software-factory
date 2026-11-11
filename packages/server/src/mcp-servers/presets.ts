import { createRequire } from 'node:module';

/**
 * Built-in MCP servers the Factory ships pinned in its own dependencies: a preset names the
 * package, so nothing is fetched at run time (`npx` of a moving version never runs here).
 */
export interface McpServerPreset {
  id: string;
  label: string;
  description: string;
  /** The installed launcher, run with this Node. */
  packageBin: { packageName: string; bin: string };
  args: string[];
  /** Plain variables a person fills (e.g. the project id). */
  env: Array<{ name: string; label: string; required: boolean }>;
  /** Secret files: the value is written to a private temp file whose path goes into the variable. */
  secretFiles: Array<{ name: string; label: string; required: boolean }>;
  /** Tools the person may want to forbid or ask for (writes), shown as a hint, never applied by default. */
  writeTools: string[];
  docsUrl: string;
}

export const MCP_SERVER_PRESETS: readonly McpServerPreset[] = [
  {
    id: 'toolbox-firestore',
    label: 'MCP Toolbox for Databases · Firestore',
    description:
      'Google’s MCP Toolbox with its Firestore tools: collections, documents, queries, security rules. ' +
      'Read-only when its service account only has the Cloud Datastore Viewer role.',
    packageBin: { packageName: '@toolbox-sdk/server', bin: 'bin/run.js' },
    args: ['--prebuilt', 'firestore', '--stdio'],
    env: [
      { name: 'FIRESTORE_PROJECT', label: 'Google Cloud project ID', required: true },
      { name: 'FIRESTORE_DATABASE', label: 'Database ID (default: "(default)")', required: false },
    ],
    secretFiles: [{ name: 'GOOGLE_APPLICATION_CREDENTIALS', label: 'Service account key (JSON)', required: true }],
    writeTools: ['add_documents', 'update_document', 'delete_documents'],
    docsUrl: 'https://mcp-toolbox.dev/integrations/firestore/prebuilt-configs/firestore/',
  },
  {
    id: 'toolbox',
    label: 'MCP Toolbox for Databases · own tools.yaml',
    description:
      'Google’s MCP Toolbox with a tools file you write: any of its databases (Postgres, MySQL, MongoDB, BigQuery…), ' +
      'only the queries you describe.',
    packageBin: { packageName: '@toolbox-sdk/server', bin: 'bin/run.js' },
    args: ['--tools-file', '${TOOLBOX_TOOLS_FILE}', '--stdio'],
    env: [],
    secretFiles: [{ name: 'TOOLBOX_TOOLS_FILE', label: 'tools.yaml (with its credentials)', required: true }],
    writeTools: [],
    docsUrl: 'https://mcp-toolbox.dev/documentation/configuration/',
  },
];

export function mcpServerPreset(id: string): McpServerPreset | undefined {
  return MCP_SERVER_PRESETS.find(preset => preset.id === id);
}

const require = createRequire(import.meta.url);

/** The installed launcher's path; throws when the package is missing (a broken install, not a fallback). */
export function presetEntrypoint(preset: McpServerPreset): string {
  const manifest = require.resolve(`${preset.packageBin.packageName}/package.json`);
  return manifest.replace(/package\.json$/, preset.packageBin.bin);
}
