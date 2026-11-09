import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

/**
 * Tests here load the real entry (`src/mastra/index.ts`) and the Mastra Code SDK, which default to the
 * user's own data: `mastra.db` and `settings.json` under the app data dir (`~/Library/Application
 * Support/mastracode` on macOS), the vector file next to it, and sandboxes and Claude Code sessions
 * under `~/.mastracode/web`. Every test file gets a fresh temporary directory for all of them instead,
 * set before any module reads the environment, so no test opens, migrates or writes real user data.
 */
const dataDir = mkdtempSync(join(tmpdir(), 'factory-app-server-test-'));

process.env.MASTRA_APP_DATA_DIR = join(dataDir, 'app-data');
process.env.MASTRA_DB_PATH = join(dataDir, 'mastra.db');
process.env.FACTORY_VECTOR_DB_PATH = join(dataDir, 'mastra-vectors.db');
process.env.MASTRA_OBSERVABILITY_DB_PATH = join(dataDir, 'observability.duckdb');
process.env.MASTRACODE_LOCAL_SANDBOX_ROOT = join(dataDir, 'sandboxes');
process.env.FACTORY_CLAUDE_CODE_STORE_DIR = join(dataDir, 'claude-code-sessions');

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});
