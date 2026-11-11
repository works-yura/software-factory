// `factory_thread_read`: the agent reads a thread's history by position, as a context handoff
// tells it to for the items it left out. Every harness gets it: Mastra sessions through
// `createFactoryTools`, Claude Code and Codex sessions over the Factory MCP route that mounts them.
import { HandoffThreadNotFoundError } from '@factory/harness-handoff';
import { createThreadReadTool } from '@factory/harness-handoff/mastra';
import type { ThreadReadSource } from '@factory/harness-handoff';
import type { IntegrationTools } from '@factory/integrations';
import type { SourceControlSessionLookup } from '@factory/session';

import type { FactoryToolScope } from './scope.ts';

export interface FactoryThreadReadDependencies {
  /**
   * The threads' history, unscoped: the host's memory-backed source. The tool checks access
   * itself before reading through it.
   */
  threadHistory?: () => ThreadReadSource | undefined;
  sessions: Pick<SourceControlSessionLookup, 'getBySessionId'>;
}

/**
 * The threads `scope` may read, as reading the session does: its own thread, and a session of
 * the same Factory unless it is another person's private one. A Factory session's thread is its
 * session id. Anything else reads as not found.
 */
export function scopedThreadReadSource(
  scope: Pick<FactoryToolScope, 'orgId' | 'factoryProjectId' | 'userId' | 'threadId'>,
  deps: FactoryThreadReadDependencies,
  history: ThreadReadSource,
): ThreadReadSource {
  const check = async (threadId: string) => {
    if (threadId === scope.threadId) return;
    const row = await deps.sessions.getBySessionId(threadId);
    if (
      !row ||
      row.orgId !== scope.orgId ||
      row.factoryProjectId !== scope.factoryProjectId ||
      (row.visibility === 'private' && row.userId !== scope.userId)
    ) {
      throw new HandoffThreadNotFoundError({ threadId });
    }
  };
  return {
    getThread: async threadId => {
      await check(threadId);
      return history.getThread(threadId);
    },
    getTimelinePage: async (threadId, options) => {
      await check(threadId);
      return history.getTimelinePage(threadId, options);
    },
  };
}

/** The tool for `scope`, or none when the host keeps no thread history. */
export function createFactoryThreadReadTools(scope: FactoryToolScope, deps: FactoryThreadReadDependencies): IntegrationTools {
  const history = deps.threadHistory?.();
  if (!history) return {};
  const source = scopedThreadReadSource(scope, deps, history);
  return { factory_thread_read: createThreadReadTool(() => source) };
}
