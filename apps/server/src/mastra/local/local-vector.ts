import { dirname, join } from 'node:path';
import { LibSQLVector } from '@mastra/libsql';
import { getDatabasePath } from '@mastra/code-sdk/utils/project';

/**
 * Local vector store for semantic recall and Knowledge when no Postgres is
 * configured. Upstream only creates a vector store from `DATABASE_URL`, which
 * leaves a libSQL deployment with no cross-session memory at all. The file
 * sits next to the main database so it never shares a path with another host.
 */
export function createLocalVector(): LibSQLVector | undefined {
  if (process.env.FACTORY_LOCAL_VECTOR === '0') return undefined;
  const path = process.env.FACTORY_VECTOR_DB_PATH?.trim() || join(dirname(getDatabasePath()), 'mastra-vectors.db');
  return new LibSQLVector({ id: 'mastra-code-vectors', url: `file:${path}` });
}
